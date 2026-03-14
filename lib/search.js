const axios = require('axios');

const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.timestamp > CACHE_TTL) searchCache.delete(k);
}, 30 * 60 * 1000);

// ===== AnimeTosho by AniDB ID (primary, fast, precise) =====

// Cache of aid → full torrent list (avoid refetching)
const aidFullCache = new Map();
const AID_FULL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

// Build episode number → anidb_eid mapping from AnimeTosho data
function buildEpisodeMap(items) {
  const epMap = new Map(); // episode_number → [anidb_eids]
  for (const item of items) {
    if (!item.anidb_eid) continue;
    // AnimeTosho title usually contains episode number
    const epNum = extractEpisodeNumber(item.title || '');
    if (epNum) {
      if (!epMap.has(epNum)) epMap.set(epNum, new Set());
      epMap.get(epNum).add(item.anidb_eid);
    }
  }
  return epMap;
}

function extractEpisodeNumber(title) {
  // Try various patterns to extract episode number
  const patterns = [
    /S\d+E(\d+)/i,           // S01E08
    /\s-\s(\d{2,3})(?:\s|\[|$)/,  // " - 08 " or " - 08["
    /\[(\d{2,3})(?:v\d)?\]/,      // [08] or [08v2]
    /\bEp?(\d{2,3})\b/i,          // E08, Ep08, EP08
    /\bEpisode\s*(\d+)/i,         // Episode 8
    /\s(\d{2,3})(?:\s*[\[\(])/,   // " 08 [" or " 08 ("
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

async function searchByAniDBId(anidbId, episode, isMovie = false, season = 1) {
  const cacheKey = `at:aid${anidbId}:ep${episode || 'all'}:s${season}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  const items = await fetchAllForAid(anidbId);
  if (!items.length) return [];

  let filtered = items;

  if (episode && !isMovie) {
    // Method 1: Filter by anidb_eid — group torrents by eid, find which eid = our episode
    const byEid = new Map();
    for (const item of items) {
      if (item.anidb_eid) {
        if (!byEid.has(item.anidb_eid)) byEid.set(item.anidb_eid, []);
        byEid.get(item.anidb_eid).push(item);
      }
    }

    // Find torrents matching our episode by title patterns
    // Search both absolute episode AND SxxExx format
    const epPad = String(episode).padStart(2, '0');
    const sEp = season > 1 ? `S${String(season).padStart(2, '0')}E${epPad}` : null;

    filtered = items.filter(item => {
      const title = item.title || '';

      // Match SxxExx (exact season+episode)
      if (sEp && title.toUpperCase().includes(sEp)) return true;

      // Match absolute episode number
      if (matchesEpisodeNum(title, episode)) return true;

      // Batch detection
      if (isBatchTorrent(title)) return true;

      return false;
    });

    // If SxxExx found specific results, prefer those over absolute matches
    if (sEp) {
      const sEpResults = filtered.filter(item => (item.title || '').toUpperCase().includes(sEp));
      if (sEpResults.length >= 3) {
        console.log(`  [AnimeTosho] Found ${sEpResults.length} with ${sEp}, preferring season format`);
        filtered = sEpResults;
      }
    }

    console.log(`  [AnimeTosho] After ep${episode}${sEp ? '/'+sEp : ''} filter: ${filtered.length}`);
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

  // AnimeTosho text search
  const queries = new Set();
  for (const name of names.slice(0, 3)) {
    if (!name) continue;
    if (episode) {
      queries.add(`${name} ${epPad}`);
      queries.add(`${name} S01E${epPad}`);
    }
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
          name: item.title || 'Unknown',
          magnet: item.magnet_uri,
          seeders: String(item.seeders || 0),
          filesize: item.total_size ? formatBytes(item.total_size) : 'Unknown',
          source: 'animetosho'
        });
      }
    }
  }

  // Filter by episode
  let filtered = allTorrents;
  if (episode && !isMovie) {
    filtered = filterTorrentsByEpisode(filtered, episode);
  }
  if (isMovie) {
    filtered = filterMovieResults(filtered, names);
  }

  console.log(`  [TextSearch] ${filtered.length} results after filtering`);
  searchCache.set(cacheKey, { data: filtered, timestamp: Date.now() });
  return filtered;
}

// ===== Episode filtering for AnimeTosho results =====
function filterByEpisode(items, episode) {
  const ep = parseInt(episode);
  const epPad = String(ep).padStart(2, '0');
  const ep3 = String(ep).padStart(3, '0');

  return items.filter(item => {
    const name = item.title || '';

    // Batch detection
    if (/\bcomplete\b|\bbatch\b|\bcollection\b/i.test(name)) return true;
    if (/\bSeason\s*\d+\b/i.test(name) && !/\bE\d{2}\b/i.test(name)) return true;
    if (/\bS\d{2}\b/i.test(name) && !/\bS\d{2}E\d{2}\b/i.test(name)) return true;
    const rangeMatch = name.match(/(\d+)\s*[-~]\s*(\d+)/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]);
      const to = parseInt(rangeMatch[2]);
      if (to > from && to - from >= 2 && ep >= from && ep <= to) return true;
    }
    if (/\b(?:BD|BDRip|Blu-?ray)\b/i.test(name) && !/\bE\d{2}\b/i.test(name) && !/\s-\s\d{1,3}[\s.\[]/i.test(name)) return true;

    // Episode matching
    if (new RegExp(`S\\d{1,2}E0*${ep}(?:\\b|[^\\d])`, 'i').test(name)) return true;
    if (new RegExp(`[-_ ]0*${ep}(?:\\s|\\[|\\(|v\\d|$)`, 'i').test(name)) return true;
    if (new RegExp(`\\[0*${ep}(?:v\\d)?\\]`, 'i').test(name)) return true;
    if (new RegExp(`\\bEp(?:isode)?[-_. ]*0*${ep}(?:\\b|[^\\d])`, 'i').test(name)) return true;
    if (new RegExp(`\\s-\\s0*${ep}(?:\\s|\\[|\\(|v\\d|\\.|$)`, 'i').test(name)) return true;
    if (new RegExp(`#0*${ep}(?:\\b|[^\\d])`, 'i').test(name)) return true;
    if (new RegExp(`[-_ ]${ep3}(?:\\s|\\[|\\(|v\\d|\\.|$)`, 'i').test(name)) return true;
    if (new RegExp(`\\.0*${ep}\\.`, 'i').test(name)) return true;

    return false;
  });
}

// Episode filter for torrent objects
function filterTorrentsByEpisode(torrents, episode) {
  const ep = parseInt(episode);
  return torrents.filter(t => {
    const item = { title: t.name };
    return filterByEpisode([item], ep).length > 0;
  });
}

// Movie filter
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
