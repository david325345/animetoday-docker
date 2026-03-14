const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.timestamp > CACHE_TTL) searchCache.delete(k);
}, 30 * 60 * 1000);

// ===== AniDB HTTP API — episode list with eids =====
const ANIDB_CLIENT = 'animetoday';
const ANIDB_CLIENTVER = 1;
const ANIDB_PROTO = 1;

// Persistent cache: aid → { episodes: [{ eid, epno, type, title }], fetched }
// Saved to disk so survives restarts
const eidCachePath = path.join(DATA_DIR, 'eid-cache.json');
let eidCache = new Map();

// Rate limiting: 1 request per 2 seconds, max 200/day
let anidbLastRequest = 0;
let anidbDailyCount = 0;
let anidbDayStart = Date.now();
const ANIDB_MIN_INTERVAL = 2500; // 2.5s to be safe
const ANIDB_DAILY_LIMIT = 180; // stay under 200

function loadEidCache() {
  try {
    if (fs.existsSync(eidCachePath)) {
      const data = JSON.parse(fs.readFileSync(eidCachePath, 'utf8'));
      eidCache = new Map(Object.entries(data));
      console.log(`  📖 EID cache: ${eidCache.size} anime loaded (local)`);
    }
  } catch {}
}

// R2 backup for eid cache
let r2Client = null;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'titulky-cache';
const R2_PREFIX = 'nyaa-anime-today/eid-cache';

function initR2() {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID || '3b9379b61dd9b19bc04ec39ac50352e8'}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || 'cb62c68d2e4147ff9ff94ce2bddd1038',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'be3d739c6be4924c3f20700fd17321d193627b91557d3a14dc0bce915f1fa14b',
      },
    });
  } catch {}
}

async function saveEidToR2(anidbId, data) {
  if (!r2Client) initR2();
  if (!r2Client) return;
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: `${R2_PREFIX}/${anidbId}.json`,
      Body: JSON.stringify(data), ContentType: 'application/json'
    }));
  } catch {}
}

async function loadEidFromR2(anidbId) {
  if (!r2Client) initR2();
  if (!r2Client) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const resp = await r2Client.send(new GetObjectCommand({
      Bucket: R2_BUCKET, Key: `${R2_PREFIX}/${anidbId}.json`
    }));
    const body = await resp.Body.transformToString();
    return JSON.parse(body);
  } catch { return null; }
}

function saveEidCache() {
  try {
    fs.writeFileSync(eidCachePath, JSON.stringify(Object.fromEntries(eidCache)), 'utf8');
  } catch {}
}

// Get episode list from AniDB API (cached permanently)
async function getAniDBEpisodes(anidbId) {
  const aid = String(anidbId);

  // Check permanent local cache
  if (eidCache.has(aid)) return eidCache.get(aid).episodes;

  // Check R2
  const r2Data = await loadEidFromR2(aid);
  if (r2Data?.episodes) {
    eidCache.set(aid, r2Data);
    saveEidCache();
    console.log(`  ☁️ EID cache from R2: aid=${aid} (${r2Data.episodes.length} episodes)`);
    return r2Data.episodes;
  }

  // Rate limit check
  const now = Date.now();
  if (now - anidbDayStart > 24 * 60 * 60 * 1000) {
    anidbDailyCount = 0;
    anidbDayStart = now;
  }
  if (anidbDailyCount >= ANIDB_DAILY_LIMIT) {
    console.log(`  ⚠️ AniDB daily limit reached (${anidbDailyCount}/${ANIDB_DAILY_LIMIT})`);
    return null;
  }

  const timeSinceLast = now - anidbLastRequest;
  if (timeSinceLast < ANIDB_MIN_INTERVAL) {
    await new Promise(r => setTimeout(r, ANIDB_MIN_INTERVAL - timeSinceLast));
  }

  try {
    const url = `http://api.anidb.net:9001/httpapi?client=${ANIDB_CLIENT}&clientver=${ANIDB_CLIENTVER}&protover=${ANIDB_PROTO}&request=anime&aid=${anidbId}`;
    console.log(`  🔌 AniDB API: fetching episodes for aid=${anidbId} (${anidbDailyCount + 1}/${ANIDB_DAILY_LIMIT} today)`);

    const resp = await axios.get(url, {
      timeout: 15000,
      responseType: 'arraybuffer',
      headers: { 'Accept-Encoding': 'gzip' }
    });

    anidbLastRequest = Date.now();
    anidbDailyCount++;

    // Decompress if gzipped
    let xml;
    try {
      xml = zlib.gunzipSync(resp.data).toString('utf8');
    } catch {
      xml = resp.data.toString('utf8');
    }

    // Check for error
    if (xml.includes('<error>')) {
      const errMatch = xml.match(/<error[^>]*>([^<]+)<\/error>/);
      console.error(`  ❌ AniDB error: ${errMatch?.[1] || 'unknown'}`);
      return null;
    }

    // Parse episodes
    const episodes = parseAniDBEpisodes(xml);
    console.log(`  📺 AniDB: ${episodes.length} episodes for aid=${anidbId}`);

    // Cache permanently (local + R2)
    const cacheData = { episodes, fetched: new Date().toISOString() };
    eidCache.set(aid, cacheData);
    saveEidCache();
    saveEidToR2(aid, cacheData); // async, non-blocking

    return episodes;
  } catch (err) {
    console.error(`  ❌ AniDB API error: ${err.message}`);
    return null;
  }
}

function parseAniDBEpisodes(xml) {
  const episodes = [];
  const epRegex = /<episode\s+id="(\d+)"[^>]*>([\s\S]*?)<\/episode>/g;
  let match;

  while ((match = epRegex.exec(xml)) !== null) {
    const eid = parseInt(match[1]);
    const content = match[2];

    // Parse epno: <epno type="1">4</epno>
    const epnoMatch = content.match(/<epno\s+type="(\d+)"[^>]*>([^<]+)<\/epno>/);
    if (!epnoMatch) continue;

    const type = parseInt(epnoMatch[1]);
    const epno = epnoMatch[2].trim();

    // Parse title
    const titleMatch = content.match(/<title\s+[^>]*xml:lang="en"[^>]*>([^<]+)<\/title>/);
    const title = titleMatch?.[1] || '';

    episodes.push({ eid, epno, type, title });
  }

  return episodes;
}

// Get eid for a specific episode number
async function getEidForEpisode(anidbId, episodeNum) {
  const episodes = await getAniDBEpisodes(anidbId);
  if (!episodes) return null;

  // Find normal episode (type=1) with matching number
  const ep = episodes.find(e => e.type === 1 && String(e.epno) === String(episodeNum));
  if (ep) return ep.eid;

  // Try parsing as integer
  const epInt = parseInt(episodeNum);
  const ep2 = episodes.find(e => e.type === 1 && parseInt(e.epno) === epInt);
  return ep2?.eid || null;
}

// ===== AnimeTosho search by eid (precise, 1 request) =====
async function searchByEid(eid, noCache = false) {
  const cacheKey = `at:eid${eid}`;
  if (!noCache) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  }

  try {
    const resp = await axios.get('https://feed.animetosho.org/json', {
      params: { eid, order: 'seeders-d' }, timeout: 10000
    });
    const items = resp.data || [];
    console.log(`  [AnimeTosho] eid=${eid} → ${items.length} results`);

    const torrents = items.filter(i => i.magnet_uri || i.info_hash).map(i => {
      if (!i.magnet_uri && i.info_hash) i.magnet_uri = `magnet:?xt=urn:btih:${i.info_hash}`;
      return {
        name: i.title || 'Unknown',
        magnet: i.magnet_uri,
        seeders: String(i.seeders || 0),
        filesize: i.total_size ? formatBytes(i.total_size) : 'Unknown',
        source: 'animetosho'
      };
    });

    // Deduplicate
    const seen = new Set();
    const deduped = torrents.filter(t => {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (!hash || seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });

    if (!noCache) searchCache.set(cacheKey, { data: deduped, timestamp: Date.now() });
    return deduped;
  } catch (err) {
    console.error(`  [AnimeTosho] eid search error: ${err.message}`);
    return [];
  }
}

// ===== AnimeTosho search by aid (fallback, all episodes) =====
async function searchByAniDBId(anidbId, episode, isMovie = false, skipBatch = false, noCache = false) {
  const cacheKey = `at:aid${anidbId}:ep${episode || 'all'}:nb${skipBatch?1:0}`;
  if (!noCache) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  }

  // If we have episode number, try eid-based search first
  if (episode && !isMovie) {
    const eid = await getEidForEpisode(anidbId, episode);
    if (eid) {
      console.log(`  🎯 AniDB aid=${anidbId} ep${episode} → eid=${eid}`);
      const eidResults = await searchByEid(eid, noCache);

      // Also fetch batch torrents from aid search (unless skipBatch)
      let batchResults = [];
      if (!skipBatch) {
        try {
        const aidResp = await axios.get('https://feed.animetosho.org/json', {
          params: { aid: anidbId, order: 'seeders-d', limit: 500 }, timeout: 15000
        });
        const aidItems = aidResp.data || [];
        batchResults = aidItems
          .filter(i => isBatchTorrent(i.title || '') && (i.magnet_uri || i.info_hash))
          .map(i => {
            if (!i.magnet_uri && i.info_hash) i.magnet_uri = `magnet:?xt=urn:btih:${i.info_hash}`;
            return {
              name: i.title || 'Unknown', magnet: i.magnet_uri,
              seeders: String(i.seeders || 0),
              filesize: i.total_size ? formatBytes(i.total_size) : 'Unknown',
              source: 'animetosho'
            };
          });
      } catch {}
      } // end skipBatch

      // Combine eid results + batch, deduplicate
      const combined = [...eidResults, ...batchResults];
      const seen = new Set();
      const deduped = combined.filter(t => {
        const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
        if (!hash || seen.has(hash)) return false;
        seen.add(hash);
        return true;
      });

      if (batchResults.length) console.log(`  📦 +${batchResults.length} batch torrents (${deduped.length} total)`);

      if (deduped.length) {
        if (!noCache) searchCache.set(cacheKey, { data: deduped, timestamp: Date.now() });
        return deduped;
      }
    }
  }

  // Fallback: search by aid with regex filtering
  console.log(`  🔄 Fallback: aid search + regex for ep${episode || 'all'}`);
  try {
    const resp = await axios.get('https://feed.animetosho.org/json', {
      params: { aid: anidbId, order: 'seeders-d', limit: 500 }, timeout: 15000
    });
    let items = resp.data || [];
    console.log(`  [AnimeTosho] aid=${anidbId} → ${items.length} results`);

    if (episode && !isMovie) {
      const ep = parseInt(episode);
      items = items.filter(item => {
        const title = item.title || '';
        if (isBatchTorrent(title)) return true;
        if (matchesEpisodeNum(title, ep)) return true;
        return false;
      });
      console.log(`  [AnimeTosho] Regex filter ep${ep}: ${items.length}`);
    }

    const torrents = items.filter(i => i.magnet_uri || i.info_hash).map(i => {
      if (!i.magnet_uri && i.info_hash) i.magnet_uri = `magnet:?xt=urn:btih:${i.info_hash}`;
      return {
        name: i.title || 'Unknown', magnet: i.magnet_uri,
        seeders: String(i.seeders || 0),
        filesize: i.total_size ? formatBytes(i.total_size) : 'Unknown',
        source: 'animetosho'
      };
    });

    const seen = new Set();
    const deduped = torrents.filter(t => {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (!hash || seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });

    if (!noCache) searchCache.set(cacheKey, { data: deduped, timestamp: Date.now() });
    return deduped;
  } catch (err) {
    console.error(`  [AnimeTosho] aid search error: ${err.message}`);
    return [];
  }
}

// ===== Episode regex (fallback only) =====
function matchesEpisodeNum(title, ep) {
  const epPad = String(ep).padStart(2, '0');
  if (new RegExp(`S\\d{1,2}E${epPad}(?:\\b|v\\d)`, 'i').test(title)) return true;
  if (new RegExp(`\\s-\\s${epPad}(?:\\s|\\[|\\(|v\\d|\\.|$)`).test(title)) return true;
  if (new RegExp(`\\[${epPad}(?:v\\d)?\\]`).test(title)) return true;
  if (new RegExp(`\\bEp(?:isode)?\\s*${epPad}(?:\\b|[^\\d])`, 'i').test(title)) return true;
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
      const magnet = item.magnet_uri || (item.info_hash ? `magnet:?xt=urn:btih:${item.info_hash}` : null);
      if (!magnet) continue;
      const hash = magnet.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        allTorrents.push({
          name: item.title || 'Unknown', magnet,
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

module.exports = { searchByAniDBId, searchByText, detectQuality, sortByGroupPriority, loadEidCache };
