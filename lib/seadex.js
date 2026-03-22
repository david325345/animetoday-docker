const axios = require('axios');

const SEADEX_BASE = 'https://releases.moe/api/collections';

// Standard public trackers for magnet links
const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

// ===== Cache =====
const seadexCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour (SeaDex data changes rarely)

// ===== Search by AniList ID =====
async function searchByAniListId(anilistId) {
  if (!anilistId) return [];

  const cacheKey = `seadex:${anilistId}`;
  const cached = seadexCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`  🏆 SeaDex: ${cached.data.length} torrents (cached) for AL ${anilistId}`);
    return cached.data;
  }

  try {
    console.log(`  🏆 SeaDex: searching AniList ${anilistId}...`);
    const resp = await axios.get(`${SEADEX_BASE}/entries/records`, {
      params: { filter: `alID=${anilistId}`, expand: 'trs' },
      timeout: 10000,
    });

    const items = resp.data?.items;
    if (!items?.length) {
      console.log(`  🏆 SeaDex: no entry for AL ${anilistId}`);
      seadexCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const entry = items[0];
    const torrents = entry.expand?.trs || [];

    // Filter: only Nyaa torrents with public infoHash
    const results = torrents
      .filter(t => t.tracker === 'Nyaa' && t.infoHash && !t.infoHash.includes('redacted'))
      .map(t => {
        const magnet = `magnet:?xt=urn:btih:${t.infoHash}${TRACKERS}`;
        const totalSize = (t.files || []).reduce((sum, f) => sum + (f.length || 0), 0);

        return {
          name: buildName(t),
          magnet,
          infohash: t.infoHash,
          seeders: '0', // SeaDex doesn't have seeder info
          filesize: formatFilesize(totalSize),
          filesizeBytes: totalSize,
          files: t.files || [],
          releaseGroup: t.releaseGroup || '',
          isBest: t.isBest || false,
          dualAudio: t.dualAudio || false,
          tags: t.tags || [],
          tracker: 'Nyaa',
          url: t.url || '',
          seadex: true, // marker
          source: 'seadex',
        };
      });

    console.log(`  🏆 SeaDex: ${results.length} Nyaa torrents for AL ${anilistId} (${torrents.length} total, ${results.filter(r => r.isBest).length} best)`);
    seadexCache.set(cacheKey, { data: results, ts: Date.now() });
    return results;
  } catch (err) {
    console.log(`  🏆 SeaDex search error: ${err.message}`);
    return [];
  }
}

// ===== Build readable name from torrent data =====
function buildName(torrent) {
  const group = torrent.releaseGroup || 'Unknown';
  // Try to get name from first file
  const firstFile = (torrent.files || [])[0];
  if (firstFile?.name) {
    return firstFile.name.replace(/\.mkv$|\.mp4$/i, '');
  }
  return `[${group}] SeaDex Release`;
}

// ===== Find file for specific episode =====
function findEpisodeFile(files, season, episode) {
  if (!files?.length) return null;

  const epPad = String(episode).padStart(2, '0');
  const seasonPad = String(season || 1).padStart(2, '0');

  // Try S01E09 format
  let match = files.find(f => {
    const n = f.name || '';
    return new RegExp(`S${seasonPad}E${epPad}(?:\\b|[^\\d])`, 'i').test(n);
  });
  if (match) return match;

  // Try " - 09" format
  match = files.find(f => {
    const n = f.name || '';
    return new RegExp(`\\s-\\s${epPad}(?:\\s|\\[|\\(|v\\d|\\.|$)`).test(n);
  });
  if (match) return match;

  // Try E09 format
  match = files.find(f => {
    const n = f.name || '';
    return new RegExp(`E${epPad}(?:\\b|[^\\d])`, 'i').test(n);
  });
  if (match) return match;

  // Fallback: by index (episode - 1)
  const idx = episode - 1;
  if (idx >= 0 && idx < files.length) return files[idx];

  return null;
}

// ===== Helpers =====
function formatFilesize(bytes) {
  if (!bytes) return '?';
  const n = parseInt(bytes);
  if (isNaN(n)) return '?';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

module.exports = {
  searchByAniListId,
  findEpisodeFile,
};
