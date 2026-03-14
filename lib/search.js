const axios = require('axios');

const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.timestamp > CACHE_TTL) searchCache.delete(k);
}, 30 * 60 * 1000);

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

// ===== Main search: by AniDB ID + episode =====
async function searchByAniDBId(anidbId, episode, isMovie = false) {
  const cacheKey = `at:aid${anidbId}:ep${episode || 'all'}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  const items = await fetchAllForAid(anidbId);
  if (!items.length) return [];

  let filtered = items;

  if (episode && !isMovie) {
    const ep = parseInt(episode);

    // Build eid→episode mapping from AnimeTosho data
    // Collect all unique eids (excluding items without eid = batch/specials)
    const eidSet = new Set();
    for (const item of items) {
      if (item.anidb_eid && item.anidb_eid > 0) eidSet.add(item.anidb_eid);
    }

    // Sort eids ascending → eid[0]=ep1, eid[1]=ep2, etc.
    const sortedEids = [...eidSet].sort((a, b) => a - b);
    const targetEid = sortedEids[ep - 1]; // ep4 → index 3

    console.log(`  [EID] ${sortedEids.length} unique eids, ep${ep} → eid ${targetEid || 'NOT FOUND'} (eids: ${sortedEids.slice(0, 8).join(',')}${sortedEids.length > 8 ? '...' : ''})`);

    if (targetEid) {
      // Filter: exact eid match + batch torrents (no eid)
      filtered = items.filter(item => {
        // Exact eid match
        if (item.anidb_eid === targetEid) return true;
        // Batch torrents (no eid assigned, or eid=0)
        if (!item.anidb_eid && isBatchTorrent(item.title || '')) return true;
        return false;
      });

      const eidCount = filtered.filter(i => i.anidb_eid === targetEid).length;
      const batchCount = filtered.length - eidCount;
      console.log(`  [AnimeTosho] eid=${targetEid}: ${eidCount} exact + ${batchCount} batch = ${filtered.length}`);
    } else {
      // Fallback to regex if eid mapping failed
      console.log(`  [EID] Fallback to regex for ep${ep}`);
      filtered = items.filter(item => {
        const title = item.title || '';
        if (isBatchTorrent(title)) return true;
        if (matchesEpisodeNum(title, ep)) return true;
        return false;
      });
      console.log(`  [AnimeTosho] Regex fallback: ${filtered.length}`);
    }
  }

  // Deduplicate by hash
  const seen = new Set();
  filtered = filtered.filter(item => {
    const magnet = item.magnet_uri || '';
    let hash = magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
    if (!hash && item.info_hash) hash = item.info_hash.toLowerCase();
    if (!hash) return false;
    if (seen.has(hash)) return false;
    seen.add(hash);
    if (!item.magnet_uri && item.info_hash) {
      item.magnet_uri = `magnet:?xt=urn:btih:${item.info_hash}`;
    }
    return true;
  });

  const torrents = filtered.filter(i => i.magnet_uri).map(i => ({
    name: i.title || 'Unknown',
    magnet: i.magnet_uri,
    seeders: String(i.seeders || 0),
    filesize: i.total_size ? formatBytes(i.total_size) : 'Unknown',
    source: 'animetosho'
  }));

  searchCache.set(cacheKey, { data: torrents, timestamp: Date.now() });
  return torrents;
}

// ===== Episode matching =====
function matchesEpisodeNum(title, ep) {
  const epPad = String(ep).padStart(2, '0');
  const ep3 = String(ep).padStart(3, '0');

  // SxxExx — must match exact episode number
  if (new RegExp(`S\\d{1,2}E${epPad}(?:\\b|v\\d)`, 'i').test(title)) return true;
  if (ep < 10 && new RegExp(`S\\d{1,2}E${ep}(?:\\b|v\\d)`, 'i').test(title)) return true;

  // " - 04 " fansub style (SubsPlease, Erai-raws)
  if (new RegExp(`\\s-\\s${epPad}(?:\\s|\\[|\\(|v\\d|\\.|$)`).test(title)) return true;
  if (ep >= 100 && new RegExp(`\\s-\\s${ep3}(?:\\s|\\[|\\(|v\\d|\\.|$)`).test(title)) return true;

  // [04] or [04v2]
  if (new RegExp(`\\[${epPad}(?:v\\d)?\\]`).test(title)) return true;

  // Episode 4, Ep04
  if (new RegExp(`\\bEp(?:isode)?\\s*${epPad}(?:\\b|[^\\d])`, 'i').test(title)) return true;

  // #04
  if (new RegExp(`#${epPad}(?:\\b|[^\\d])`).test(title)) return true;

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

// ===== Text search fallback =====
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
    const nameNorm = (t.name || '').toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/[\[\]()_\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nameNorm.includes(shortestName)) return false;
    if (/\bS\d+E\d+\b/i.test(t.name)) return false;
    if (/\bEpisode\s+\d+/i.test(t.name)) return false;
    if (/\s-\s\d{1,3}(?:\s|[.\[v]|$)/.test(t.name)) return false;
    return true;
  });
}

// ===== Quality & sorting =====
function detectQuality(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('2160p') || n.includes('4k')) return '4K';
  if (n.includes('1080p')) return '1080p';
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
