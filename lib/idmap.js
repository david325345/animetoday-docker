const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const DATA_DIR = path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// R2 client (reuse from config)
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

// ===== In-memory databases =====
// anime-offline-database: indexed by various IDs for fast lookup
let offlineDB = {
  byAniDB: new Map(),    // anidb_id → entry
  byAniList: new Map(),  // anilist_id → entry
  byMAL: new Map(),      // mal_id → entry
  byKitsu: new Map(),    // kitsu_id → entry
  byIMDb: new Map(),     // imdb_id → entry
  loaded: false,
  lastUpdate: null
};

// Custom mapping cache: imdb/kitsu/anilist → anidb (grows over time)
let mappingCache = new Map(); // key → { anidb, anilist, mal, kitsu, title }
const MAPPING_PATH = path.join(DATA_DIR, 'id-mapping.json');

// ===== Load anime-offline-database =====
async function loadOfflineDB() {
  const localPath = path.join(DATA_DIR, 'anime-offline-database-minified.json');

  // Try local first
  if (fs.existsSync(localPath)) {
    try {
      console.log('📦 Loading anime-offline-database from local...');
      const raw = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      indexOfflineDB(raw.data || []);
      console.log(`📦 Indexed ${offlineDB.byAniDB.size} AniDB, ${offlineDB.byIMDb.size} IMDb entries`);
      return;
    } catch (err) {
      console.error('📦 Local DB parse error:', err.message);
    }
  }

  // Try R2
  try {
    console.log('☁️ Loading anime-offline-database from R2...');
    const resp = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `${R2_PREFIX}/anime-offline-database-minified.json` }));
    const body = await resp.Body.transformToString();
    fs.writeFileSync(localPath, body, 'utf8');
    const raw = JSON.parse(body);
    indexOfflineDB(raw.data || []);
    console.log(`☁️ Indexed ${offlineDB.byAniDB.size} AniDB, ${offlineDB.byIMDb.size} IMDb entries`);
    return;
  } catch {}

  // Download from GitHub
  await downloadOfflineDB();
}

async function downloadOfflineDB() {
  const localPath = path.join(DATA_DIR, 'anime-offline-database-minified.json');
  console.log('⬇️ Downloading anime-offline-database from GitHub...');
  try {
    const resp = await axios.get(
      'https://raw.githubusercontent.com/manami-project/anime-offline-database/master/anime-offline-database-minified.json',
      { timeout: 60000, responseType: 'text', maxContentLength: 100 * 1024 * 1024 }
    );
    fs.writeFileSync(localPath, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data), 'utf8');
    const raw = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    indexOfflineDB(raw.data || []);
    console.log(`⬇️ Indexed ${offlineDB.byAniDB.size} AniDB, ${offlineDB.byIMDb.size} IMDb entries`);

    // Backup to R2
    try {
      await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: `${R2_PREFIX}/anime-offline-database-minified.json`,
        Body: fs.readFileSync(localPath), ContentType: 'application/json'
      }));
      console.log('☁️ Backed up offline DB to R2');
    } catch {}
  } catch (err) {
    console.error('⬇️ Download failed:', err.message);
  }
}

function indexOfflineDB(entries) {
  offlineDB.byAniDB.clear();
  offlineDB.byAniList.clear();
  offlineDB.byMAL.clear();
  offlineDB.byKitsu.clear();
  offlineDB.byIMDb.clear();

  for (const entry of entries) {
    const ids = extractIDs(entry.sources || []);
    const record = { ...ids, title: entry.title, synonyms: entry.synonyms || [], type: entry.type };

    if (ids.anidb) offlineDB.byAniDB.set(ids.anidb, record);
    if (ids.anilist) offlineDB.byAniList.set(ids.anilist, record);
    if (ids.mal) offlineDB.byMAL.set(ids.mal, record);
    if (ids.kitsu) offlineDB.byKitsu.set(ids.kitsu, record);
    if (ids.imdb) offlineDB.byIMDb.set(ids.imdb, record);
  }

  offlineDB.loaded = true;
  offlineDB.lastUpdate = new Date().toISOString();
}

function extractIDs(sources) {
  const ids = {};
  for (const url of sources) {
    const m = url.match(/anidb\.net\/anime\/(\d+)/);
    if (m) ids.anidb = parseInt(m[1]);
    const m2 = url.match(/anilist\.co\/anime\/(\d+)/);
    if (m2) ids.anilist = parseInt(m2[1]);
    const m3 = url.match(/myanimelist\.net\/anime\/(\d+)/);
    if (m3) ids.mal = parseInt(m3[1]);
    const m4 = url.match(/kitsu\.app\/anime\/(\d+)/);
    if (m4) ids.kitsu = parseInt(m4[1]);
    // IMDb not in anime-offline-database sources, but we handle it via ids.moe
  }
  return ids;
}

// ===== Load/Save mapping cache =====
async function loadMappingCache() {
  // Local first
  if (fs.existsSync(MAPPING_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
      mappingCache = new Map(Object.entries(data));
      console.log(`🗂️ Mapping cache: ${mappingCache.size} entries (local)`);
      return;
    } catch {}
  }
  // R2
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `${R2_PREFIX}/id-mapping.json` }));
    const body = await resp.Body.transformToString();
    const data = JSON.parse(body);
    mappingCache = new Map(Object.entries(data));
    fs.writeFileSync(MAPPING_PATH, body, 'utf8');
    console.log(`☁️ Mapping cache: ${mappingCache.size} entries (R2)`);
  } catch {
    console.log('🗂️ No mapping cache yet');
  }
}

async function saveMappingCache() {
  const obj = Object.fromEntries(mappingCache);
  try {
    fs.writeFileSync(MAPPING_PATH, JSON.stringify(obj), 'utf8');
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: `${R2_PREFIX}/id-mapping.json`,
      Body: JSON.stringify(obj), ContentType: 'application/json'
    }));
  } catch (err) {
    console.error('🗂️ Mapping save error:', err.message);
  }
}

// ===== Main resolver: any ID → AniDB ID =====
async function resolveToAniDB(type, fullId) {
  // Parse Stremio ID
  let platform, id;

  if (fullId.startsWith('kitsu:')) {
    platform = 'kitsu';
    id = parseInt(fullId.split(':')[1]);
  } else if (fullId.startsWith('tt')) {
    platform = 'imdb';
    id = fullId.split(':')[0]; // tt1234567
  } else {
    platform = 'imdb';
    id = fullId.split(':')[0];
  }

  const cacheKey = `${platform}:${id}`;

  // 1. Check mapping cache (RAM)
  if (mappingCache.has(cacheKey)) {
    const cached = mappingCache.get(cacheKey);
    if (cached.anidb) return cached;
  }

  // 2. Check anime-offline-database (RAM)
  let record = null;
  if (platform === 'kitsu') record = offlineDB.byKitsu.get(id);
  else if (platform === 'imdb') record = offlineDB.byIMDb.get(id);
  else if (platform === 'mal') record = offlineDB.byMAL.get(id);
  else if (platform === 'anilist') record = offlineDB.byAniList.get(id);

  // If offline DB doesn't have IMDb (it usually doesn't), try via Cinemeta → AniList → offline DB
  if (!record && platform === 'imdb') {
    record = await resolveIMDbViaChain(type, id);
  }

  if (record?.anidb) {
    mappingCache.set(cacheKey, record);
    saveMappingCache(); // async, non-blocking
    console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (offline-db) "${record.title}"`);
    return record;
  }

  // 3. Fallback: ids.moe API
  const idsMoeResult = await queryIdsMoe(platform, id);
  if (idsMoeResult?.anidb) {
    mappingCache.set(cacheKey, idsMoeResult);
    saveMappingCache();
    console.log(`  🆔 ${cacheKey} → AniDB ${idsMoeResult.anidb} (ids.moe) "${idsMoeResult.title}"`);
    return idsMoeResult;
  }

  console.log(`  🆔 ${cacheKey} → No AniDB ID found`);
  return null;
}

// Resolve IMDb via Cinemeta → AniList name → offline DB AniList lookup
async function resolveIMDbViaChain(type, imdbId) {
  try {
    // Get AniList/MAL ID via Cinemeta → AniList search
    const cineResp = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const name = cineResp.data?.meta?.name;
    if (!name) return null;

    // Search AniList for the name
    const gql = `query ($search: String) { Page(page:1, perPage:5) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } } } }`;
    const alResp = await axios.post('https://graphql.anilist.co', { query: gql, variables: { search: name } }, { timeout: 8000 });
    const media = alResp.data?.data?.Page?.media;
    if (!media?.length) return null;

    // Try to find in offline DB by AniList ID
    for (const m of media) {
      const record = offlineDB.byAniList.get(m.id);
      if (record?.anidb) {
        return { ...record, title: name };
      }
    }

    // If we found AniList ID but no AniDB in offline DB, try ids.moe with AniList
    const anilistId = media[0].id;
    const idsMoe = await queryIdsMoe('anilist', anilistId);
    if (idsMoe?.anidb) return { ...idsMoe, title: name };

    return null;
  } catch { return null; }
}

// Query ids.moe API
async function queryIdsMoe(platform, id) {
  // ids.moe platform mapping
  const platformMap = {
    'imdb': 'imdb', 'kitsu': 'kitsu', 'anilist': 'anilist',
    'mal': 'mal', 'anidb': 'anidb'
  };
  const p = platformMap[platform];
  if (!p) return null;

  try {
    const resp = await axios.get(`https://api.ids.moe/ids/${id}`, {
      params: { p }, timeout: 5000
    });
    const d = resp.data;
    if (!d) return null;
    return {
      anidb: d.anidb || null,
      anilist: d.anilist || null,
      mal: d.myanimelist || null,
      kitsu: d.kitsu || null,
      imdb: d.imdb || null,
      title: d.title || ''
    };
  } catch (err) {
    console.error(`  🆔 ids.moe error (${platform}:${id}):`, err.message);
    return null;
  }
}

// ===== Parse episode/season from Stremio ID =====
function parseEpisodeAndSeason(fullId) {
  const parts = fullId.split(':');
  if (fullId.startsWith('kitsu:')) return { season: 1, episode: parseInt(parts[2]) || 1 };
  if (parts.length >= 3) return { season: parseInt(parts[1]) || 1, episode: parseInt(parts[2]) || 1 };
  return { season: 1, episode: parseInt(parts[1]) || 1 };
}

// ===== Weekly update =====
async function weeklyUpdate() {
  console.log('📦 Weekly anime-offline-database update...');
  await downloadOfflineDB();
}

module.exports = {
  loadOfflineDB, loadMappingCache, resolveToAniDB, parseEpisodeAndSeason,
  weeklyUpdate, offlineDB, mappingCache
};
