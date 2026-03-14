const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.timestamp > CACHE_TTL) searchCache.delete(k);
}, 30 * 60 * 1000);

// R2 for episode mapping persistence
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID || '3b9379b61dd9b19bc04ec39ac50352e8'}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || 'cb62c68d2e4147ff9ff94ce2bddd1038',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'be3d739c6be4924c3f20700fd17321d193627b91557d3a14dc0bce915f1fa14b',
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'titulky-cache';
const R2_PREFIX = 'nyaa-anime-today';

// ===== Episode mapping cache: aid → { eidToEp, epToEids } =====
// Stored in RAM + R2 for persistence
const episodeMapCache = new Map(); // aid → { mapping, timestamp }
const EP_MAP_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Load episode mapping from R2
async function loadEpisodeMap(anidbId) {
  // RAM first
  const cached = episodeMapCache.get(anidbId);
  if (cached && Date.now() - cached.timestamp < EP_MAP_TTL) return cached.mapping;

  // R2
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: R2_BUCKET, Key: `${R2_PREFIX}/epmaps/${anidbId}.json`
    }));
    const body = await resp.Body.transformToString();
    const mapping = JSON.parse(body);
    episodeMapCache.set(anidbId, { mapping, timestamp: Date.now() });
    console.log(`  [EpMap] Loaded from R2 for aid=${anidbId} (${Object.keys(mapping.epToEids || {}).length} episodes)`);
    return mapping;
  } catch {
    return null;
  }
}

// Save episode mapping to R2
async function saveEpisodeMap(anidbId, mapping) {
  episodeMapCache.set(anidbId, { mapping, timestamp: Date.now() });
  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: `${R2_PREFIX}/epmaps/${anidbId}.json`,
      Body: JSON.stringify(mapping), ContentType: 'application/json'
    }));
    console.log(`  [EpMap] Saved to R2 for aid=${anidbId}`);
  } catch (err) {
    console.error(`  [EpMap] R2 save error: ${err.message}`);
  }
}

// ===== Build episode mapping from AnimeTosho data =====
function buildEpisodeMapping(items) {
  // Group torrents by anidb_eid
  const eidGroups = new Map(); // eid → [items]
  for (const item of items) {
    if (!item.anidb_eid || !item.magnet_uri) continue;
    const eid = item.anidb_eid;
    if (!eidGroups.has(eid)) eidGroups.set(eid, []);
    eidGroups.get(eid).push(item);
  }

  // Sort eids numerically → eid order = episode order
  const sortedEids = [...eidGroups.keys()].sort((a, b) => a - b);

  // Build ep number → eids mapping
  // Episode 1 = smallest eid, Episode 2 = second smallest, etc.
  const epToEids = {}; // "1" → [eid1], "2" → [eid2]
  const eidToEp = {};  // eid → episode_number

  for (let i = 0; i < sortedEids.length; i++) {
    const ep = i + 1;
    const eid = sortedEids[i];
    epToEids[ep] = eid;
    eidToEp[eid] = ep;
  }

  return { epToEids, eidToEp, totalEpisodes: sortedEids.length, eidGroups: Object.fromEntries([...eidGroups.entries()].map(([k, v]) => [k, v.length])) };
}

// ===== AnimeTosho fetch all torrents for an anime =====
const aidFullCache = new Map();
const AID_FULL_CACHE_TTL = 60 * 60 * 1000;

async function fetchAllForAid(anidbId) {
  const cached = aidFullCache.get(anidbId);
  if (cached && Date.now() - cached.timestamp < AID_FULL_CACHE_TTL) return cached.data;

  try {
    const resp = await axios.get('https://feed.animetosho.org/json', {
      params: { aid: anidbId, order: 'seeders-d', limit: 500 }, timeout: 15000
    });
    const items = resp.data || [];
    console.log(`  [AnimeTosho] aid=${anidbId} → ${items.length} total results`);
    aidFullCache.set(anidbId, { data: items, timestamp: Date.now() });
    return items;
  } catch (err) {
    console.error(`  [AnimeTosho] Error: ${err.message}`);
    return [];
  }
}

// ===== Main search function =====
async function searchByAniDBId(anidbId, episode, isMovie = false, season = 1, originalEpisode = null) {
  const origEp = originalEpisode || episode;
  const cacheKey = `at:aid${anidbId}:ep${episode}:s${season}:oe${origEp}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  const items = await fetchAllForAid(anidbId);
  if (!items.length) return [];

  let filtered = items;

  if (episode && !isMovie) {
    // Try eid-based matching first (most precise)
    let mapping = await loadEpisodeMap(anidbId);

    if (!mapping) {
      // Build mapping from AnimeTosho data
      mapping = buildEpisodeMapping(items);
      if (mapping.totalEpisodes > 0) {
        saveEpisodeMap(anidbId, mapping); // async, save to R2
        console.log(`  [EpMap] Built: ${mapping.totalEpisodes} episodes for aid=${anidbId}`);
      }
    }

    const targetEp = parseInt(episode);
    let targetEid = null;

    if (mapping && mapping.epToEids && mapping.totalEpisodes > 0) {
      // Find eid for our target episode
      targetEid = mapping.epToEids[targetEp];

      if (targetEid) {
        console.log(`  [EpMap] Episode ${targetEp} → eid ${targetEid}`);

        // Filter torrents by this exact eid + batch torrents
        filtered = items.filter(item => {
          if (item.anidb_eid === targetEid) return true;
          if (isBatchTorrent(item.title || '')) return true;
          return false;
        });

        console.log(`  [AnimeTosho] eid=${targetEid} → ${filtered.filter(i => i.anidb_eid === targetEid).length} exact + batch`);
      } else {
        console.log(`  [EpMap] Episode ${targetEp} not in mapping (${mapping.totalEpisodes} total eps)`);
      }
    }

    // Fallback to regex if eid matching found nothing or mapping unavailable
    if (!targetEid || filtered.length === 0) {
      console.log(`  [Fallback] Using regex matching for ep${episode}/S${String(season).padStart(2,'0')}E${String(origEp).padStart(2,'0')}`);
      filtered = regexFilterEpisode(items, episode, season, origEp);
    }

    // Deduplicate
    const seen = new Set();
    filtered = filtered.filter(item => {
      const hash = item.magnet_uri?.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
      if (!hash || seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });

    console.log(`  [AnimeTosho] Final: ${filtered.length} torrents for ep${episode}`);
  }

  const torrents = filtered.filter(i => i.magnet_uri).map(i => ({
    name: i.title || 'Unknown',
    magnet: i.magnet_uri,
    seeders: String(i.seeders || 0),
    filesize: i.total_size ? formatBytes(i.total_size) : 'Unknown',
    source: 'animetosho',
    anidb_eid: i.anidb_eid || null
  }));

  searchCache.set(cacheKey, { data: torrents, timestamp: Date.now() });
  return torrents;
}

// Regex-based episode fallback
function regexFilterEpisode(items, episode, season, origEp) {
  const epPad = String(origEp).padStart(2, '0');
  const seasonPad = String(season).padStart(2, '0');
  const sEp = season > 1 ? `S${seasonPad}E${epPad}` : null;

  const sEpMatches = [];
  const absMatches = [];
  const batchMatches = [];

  for (const item of items) {
    const title = item.title || '';
    const titleUpper = title.toUpperCase();

    if (sEp && titleUpper.includes(sEp)) { sEpMatches.push(item); continue; }

    if (episode !== origEp) {
      const absEpPad = String(episode).padStart(2, '0');
      if (titleUpper.includes(`S01E${absEpPad}`)) { absMatches.push(item); continue; }
    }

    if (matchesEpisodeNum(title, episode)) { absMatches.push(item); continue; }

    if (isBatchTorrent(title)) { batchMatches.push(item); }
  }

  if (sEpMatches.length >= 2) return [...sEpMatches, ...batchMatches];
  return [...sEpMatches, ...absMatches, ...batchMatches];
}

function matchesEpisodeNum(title, episode) {
  const ep = parseInt(episode);
  const epPad = String(ep).padStart(2, '0');
  const ep3 = String(ep).padStart(3, '0');
  if (new RegExp(`S\\d{1,2}E0*${ep}(?:\\b|[^\\d])`, 'i').test(title)) return true;
  if (new RegExp(`\\s-\\s0*${ep}(?:\\s|\\[|\\(|v\\d|\\.|$)`).test(title)) return true;
  if (new RegExp(`\\[0*${ep}(?:v\\d)?\\]`).test(title)) return true;
  if (new RegExp(`\\bEp(?:isode)?[-_. ]*0*${ep}(?:\\b|[^\\d])`, 'i').test(title)) return true;
  if (new RegExp(`#0*${ep}(?:\\b|[^\\d])`).test(title)) return true;
  if (new RegExp(`[-_ ]${ep3}(?:\\s|\\[|\\(|v\\d|\\.|$)`).test(title)) return true;
  if (new RegExp(`\\.0*${ep}\\.`).test(title)) return true;
  return false;
}

function isBatchTorrent(title) {
  if (/\bcomplete\b|\bbatch\b|\bcollection\b/i.test(title)) return true;
  if (/\bSeason\s*\d+\b/i.test(title) && !/\bE\d{2}\b/i.test(title)) return true;
  if (/\bS\d{2}\b/i.test(title) && !/\bS\d{2}E\d{2}\b/i.test(title)) return true;
  const rangeMatch = title.match(/(\d+)\s*[-~]\s*(\d+)/);
  if (rangeMatch && parseInt(rangeMatch[2]) > parseInt(rangeMatch[1]) + 1) return true;
  if (/\b(?:BD|BDRip|Blu-?ray)\b/i.test(title) && !/\bE\d{2}\b/i.test(title) && !/\s-\s\d{1,3}[\s.\[]/i.test(title)) return true;
  return false;
}

// ===== Text search fallback (when no AniDB ID) =====
async function searchByText(names, episode, isMovie = false) {
  const cacheKey = `text:${names.join('|')}:ep${episode || 'all'}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  const seenHashes = new Set();
  const allTorrents = [];
  const epPad = episode ? String(episode).padStart(2, '0') : '';

  const queries = new Set();
  for (const name of names.slice(0, 3)) {
    if (!name) continue;
    if (episode) { queries.add(`${name} ${epPad}`); queries.add(`${name} S01E${epPad}`); }
    queries.add(name);
  }

  const queryList = [...queries].slice(0, 6);
  console.log(`  [TextSearch] ${queryList.length} queries for [${names.join(', ')}]`);

  const results = await Promise.allSettled(
    queryList.map(q =>
      axios.get('https://feed.animetosho.org/json', {
        params: { q, qx: 1, limit: 50 }, timeout: 10000
      }).then(r => r.data || []).catch(() => [])
    )
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of (r.value || [])) {
      if (!item.magnet_uri) continue;
      const hash = item.magnet_uri.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        allTorrents.push({
          name: item.title || 'Unknown', magnet: item.magnet_uri,
          seeders: String(item.seeders || 0),
          filesize: item.total_size ? formatBytes(item.total_size) : 'Unknown',
          source: 'animetosho'
        });
      }
    }
  }

  let filtered = allTorrents;
  if (isMovie) filtered = filterMovieResults(filtered, names);

  console.log(`  [TextSearch] ${filtered.length} results`);
  searchCache.set(cacheKey, { data: filtered, timestamp: Date.now() });
  return filtered;
}

function filterMovieResults(torrents, names) {
  const movieNames = names.map(n => n.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/\s+/g, ' ').trim());
  const shortestName = movieNames.reduce((a, b) => a.length <= b.length ? a : b, movieNames[0]);
  return torrents.filter(t => {
    const name = t.name || '';
    const nameNorm = name.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/[\[\]()_\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nameNorm.includes(shortestName)) return false;
    if (/\bS\d+E\d+\b/i.test(name)) return false;
    if (/\bEpisode\s+\d+/i.test(name)) return false;
    if (/\s-\s\d{1,3}(?:\s|[.\[v]|$)/.test(name)) return false;
    if (/\bS\d{2}\b/i.test(name) && !/movie|film|gekijouban/i.test(name)) return false;
    if (/\bSeason\s*\d+/i.test(name)) return false;
    return true;
  });
}

// ===== Quality & sorting =====
function detectQuality(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return '4K';
  if (n.includes('1080p') || n.includes('fullhd')) return '1080p';
  if (n.includes('720p')) return '720p';
  if (n.includes('480p')) return '480p';
  return '';
}

const TOP_GROUPS = ['SubsPlease', 'Erai-raws'];
const OTHER_GROUPS = ['EMBER', 'ASW'];

function sortByGroupPriority(torrents) {
  function getPriority(name) {
    const all = [...TOP_GROUPS, ...OTHER_GROUPS];
    for (let i = 0; i < all.length; i++) if ((name || '').includes(all[i])) return i;
    return all.length;
  }
  const withMagnet = torrents.filter(t => t.magnet);
  const top = withMagnet.filter(t => TOP_GROUPS.some(g => (t.name || '').includes(g)) && /1080p/i.test(t.name || ''))
    .sort((a, b) => getPriority(a.name) - getPriority(b.name) || (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0));
  const topSet = new Set(top.map(t => t.magnet));
  const rest = withMagnet.filter(t => !topSet.has(t.magnet))
    .sort((a, b) => {
      const a1 = /1080p/i.test(a.name) ? 0 : 1, b1 = /1080p/i.test(b.name) ? 0 : 1;
      if (a1 !== b1) return a1 - b1;
      return getPriority(a.name) - getPriority(b.name) || (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0);
    });
  return [...top, ...rest];
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GiB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MiB';
  return (bytes / 1024).toFixed(1) + ' KiB';
}

module.exports = { searchByAniDBId, searchByText, detectQuality, sortByGroupPriority };
