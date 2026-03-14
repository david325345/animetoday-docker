const axios = require('axios');

const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.timestamp > CACHE_TTL) searchCache.delete(k);
}, 30 * 60 * 1000);

// ===== AnimeTosho by AniDB ID (primary, fast, precise) =====
async function searchByAniDBId(anidbId, episode, isMovie = false) {
  const cacheKey = `at:aid${anidbId}:ep${episode || 'all'}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  try {
    const params = { aid: anidbId, order: 'seeders-d', limit: 100 };
    const resp = await axios.get('https://feed.animetosho.org/json', { params, timeout: 10000 });
    let items = resp.data || [];

    console.log(`  [AnimeTosho] aid=${anidbId} → ${items.length} total results`);

    // Filter by episode if needed
    if (episode && !isMovie) {
      items = filterByEpisode(items, episode);
      console.log(`  [AnimeTosho] After ep${episode} filter: ${items.length}`);
    }

    const torrents = items.filter(i => i.magnet_uri).map(i => ({
      name: i.title || 'Unknown',
      magnet: i.magnet_uri,
      seeders: String(i.seeders || 0),
      filesize: i.total_size ? formatBytes(i.total_size) : 'Unknown',
      source: 'animetosho'
    }));

    searchCache.set(cacheKey, { data: torrents, timestamp: Date.now() });
    return torrents;
  } catch (err) {
    console.error(`  [AnimeTosho] Error: ${err.message}`);
    return [];
  }
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
