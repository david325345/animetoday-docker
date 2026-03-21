const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ===== R2 client =====
let r2 = null;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'titulky-cache';
const R2_PREFIX = 'nyaa-anime-today';

function getR2() {
  if (r2) return r2;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID || '3b9379b61dd9b19bc04ec39ac50352e8'}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || 'cb62c68d2e4147ff9ff94ce2bddd1038',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'be3d739c6be4924c3f20700fd17321d193627b91557d3a14dc0bce915f1fa14b',
      },
    });
  } catch {}
  return r2;
}

async function r2Get(key) {
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const resp = await getR2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `${R2_PREFIX}/${key}` }));
    return await resp.Body.transformToString();
  } catch { return null; }
}

async function r2Put(key, data) {
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getR2().send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: `${R2_PREFIX}/${key}`,
      Body: typeof data === 'string' ? data : JSON.stringify(data),
      ContentType: 'application/json'
    }));
    return true;
  } catch { return false; }
}

// ===== anime-offline-database (40k anime, RAM indexed) =====
let offlineDB = {
  byAniDB: new Map(), byAniList: new Map(), byMAL: new Map(), byKitsu: new Map(),
  loaded: false
};

// ===== anime-lists: TVDB/IMDb→AniDB per-season mapping =====
let animeListsByTVDB = new Map();
let animeListsByIMDb = new Map();
let animeListsByAniDB = new Map();
let animeListsLoaded = false;

// ===== Mapping cache (IMDb/Kitsu→AniDB results) =====
let mappingCache = new Map();

// ===== Load anime-offline-database =====
async function loadOfflineDB() {
  const localPath = path.join(DATA_DIR, 'anime-offline-database-minified.json');

  // 1. Local disk
  if (fs.existsSync(localPath)) {
    try {
      console.log('📦 Loading anime-offline-database from local...');
      const raw = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      indexOfflineDB(raw.data || []);
      console.log(`📦 Indexed ${offlineDB.byAniDB.size} AniDB, ${offlineDB.byAniList.size} AniList entries`);
      return;
    } catch (err) { console.error('📦 Parse error:', err.message); }
  }

  // 2. R2
  const r2Data = await r2Get('anime-offline-database-minified.json');
  if (r2Data) {
    try {
      fs.writeFileSync(localPath, r2Data, 'utf8');
      const raw = JSON.parse(r2Data);
      indexOfflineDB(raw.data || []);
      console.log(`☁️ anime-offline-database from R2: ${offlineDB.byAniDB.size} AniDB entries`);
      return;
    } catch {}
  }

  // 3. GitHub
  await downloadOfflineDB();
}

async function downloadOfflineDB() {
  const localPath = path.join(DATA_DIR, 'anime-offline-database-minified.json');
  console.log('⬇️ Downloading anime-offline-database from GitHub...');
  try {
    const resp = await axios.get(
      'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json',
      { timeout: 120000, responseType: 'text', maxContentLength: 200 * 1024 * 1024 }
    );
    const text = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    fs.writeFileSync(localPath, text, 'utf8');
    const raw = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    indexOfflineDB(raw.data || []);
    console.log(`⬇️ Indexed ${offlineDB.byAniDB.size} AniDB entries`);
    // Backup to R2
    r2Put('anime-offline-database-minified.json', text).then(ok => { if (ok) console.log('☁️ anime-offline-database backed up to R2'); });
  } catch (err) { console.error('⬇️ Download failed:', err.message); }
}

function indexOfflineDB(entries) {
  offlineDB.byAniDB.clear(); offlineDB.byAniList.clear();
  offlineDB.byMAL.clear(); offlineDB.byKitsu.clear();
  for (const entry of entries) {
    const ids = {};
    for (const url of (entry.sources || [])) {
      const m1 = url.match(/anidb\.net\/anime\/(\d+)/); if (m1) ids.anidb = parseInt(m1[1]);
      const m2 = url.match(/anilist\.co\/anime\/(\d+)/); if (m2) ids.anilist = parseInt(m2[1]);
      const m3 = url.match(/myanimelist\.net\/anime\/(\d+)/); if (m3) ids.mal = parseInt(m3[1]);
      const m4 = url.match(/kitsu\.app\/anime\/(\d+)/); if (m4) ids.kitsu = parseInt(m4[1]);
    }
    const record = { ...ids, title: entry.title, synonyms: entry.synonyms || [], type: entry.type, episodes: entry.episodes };
    if (ids.anidb) offlineDB.byAniDB.set(ids.anidb, record);
    if (ids.anilist) offlineDB.byAniList.set(ids.anilist, record);
    if (ids.mal) offlineDB.byMAL.set(ids.mal, record);
    if (ids.kitsu) offlineDB.byKitsu.set(ids.kitsu, record);
  }
  offlineDB.loaded = true;
}

// ===== Load anime-lists XML =====
async function loadAnimeLists() {
  const localPath = path.join(DATA_DIR, 'anime-list.xml');
  let xml = '';

  // 1. Local
  if (fs.existsSync(localPath)) {
    xml = fs.readFileSync(localPath, 'utf8');
    console.log('📋 Loaded anime-lists from local');
  }

  // 2. R2
  if (!xml) {
    const r2Data = await r2Get('anime-list.xml');
    if (r2Data) {
      xml = r2Data;
      fs.writeFileSync(localPath, xml, 'utf8');
      console.log('☁️ anime-lists from R2');
    }
  }

  // 3. GitHub
  if (!xml) {
    console.log('⬇️ Downloading anime-lists XML...');
    try {
      const resp = await axios.get(
        'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml',
        { timeout: 30000, responseType: 'text' }
      );
      xml = resp.data || '';
      fs.writeFileSync(localPath, xml, 'utf8');
      console.log('⬇️ Downloaded anime-lists XML');
      r2Put('anime-list.xml', xml).then(ok => { if (ok) console.log('☁️ anime-lists backed up to R2'); });
    } catch (err) {
      console.error('⬇️ anime-lists download failed:', err.message);
      return;
    }
  }

  parseAnimeLists(xml);
}

function parseAnimeLists(xml) {
  const entryRegex = /<anime\s+([^>]+)>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;
  animeListsByTVDB.clear(); animeListsByIMDb.clear(); animeListsByAniDB.clear();
  let count = 0;

  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const attrs = {};
    let am;
    while ((am = attrRegex.exec(match[1])) !== null) attrs[am[1]] = am[2];
    attrRegex.lastIndex = 0;

    const anidbid = parseInt(attrs.anidbid);
    const tvdbid = attrs.tvdbid;
    const defaulttvdbseason = parseInt(attrs.defaulttvdbseason) || 1;
    const episodeoffset = parseInt(attrs.episodeoffset) || 0;
    const imdbid = attrs.imdbid || '';

    if (!anidbid || !tvdbid || tvdbid === 'unknown') continue;

    const entryStart = match.index;
    const entryEnd = xml.indexOf('</anime>', entryStart);
    const entryXml = entryEnd > entryStart ? xml.substring(entryStart, entryEnd) : '';

    const mappings = [];
    const mapRegex = /<mapping\s+([^>]*)>([^<]*)<\/mapping>/g;
    let mm;
    while ((mm = mapRegex.exec(entryXml)) !== null) {
      const mapAttrs = {};
      let ma;
      const maRegex = /(\w+)="([^"]*)"/g;
      while ((ma = maRegex.exec(mm[1])) !== null) mapAttrs[ma[1]] = ma[2];
      mappings.push({
        anidbseason: parseInt(mapAttrs.anidbseason) || 1,
        tvdbseason: parseInt(mapAttrs.tvdbseason) || 1,
        start: parseInt(mapAttrs.start) || 0,
        end: parseInt(mapAttrs.end) || 0,
        offset: parseInt(mapAttrs.offset) || 0,
        text: mm[2] || ''
      });
    }

    const entry = { anidbid, tvdbid, defaulttvdbseason, episodeoffset, imdbid, mappings };

    if (!animeListsByTVDB.has(tvdbid)) animeListsByTVDB.set(tvdbid, []);
    animeListsByTVDB.get(tvdbid).push(entry);

    if (imdbid && imdbid.startsWith('tt')) {
      if (!animeListsByIMDb.has(imdbid)) animeListsByIMDb.set(imdbid, []);
      animeListsByIMDb.get(imdbid).push(entry);
    }

    animeListsByAniDB.set(String(anidbid), entry);
    count++;
  }

  animeListsLoaded = true;
  console.log(`📋 Parsed ${count} anime-lists entries (${animeListsByTVDB.size} TVDB, ${animeListsByIMDb.size} IMDb)`);

  // Enrich offlineDB records with IMDb and TVDB from anime-lists
  let enriched = 0;
  for (const [anidbId, entry] of animeListsByAniDB) {
    const rec = offlineDB.byAniDB.get(parseInt(anidbId));
    if (rec) {
      if (entry.imdbid && entry.imdbid.startsWith('tt') && !rec.imdb) {
        rec.imdb = entry.imdbid;
        enriched++;
      }
      if (entry.tvdbid && entry.tvdbid !== 'unknown' && !rec.tvdb) {
        rec.tvdb = entry.tvdbid;
      }
    }
  }
  console.log(`📋 Enriched ${enriched} offline-db records with IMDb from anime-lists`);
}

// ===== Load/Save mapping cache =====
async function loadMappingCache() {
  // 1. Local
  const localPath = path.join(DATA_DIR, 'mapping-cache.json');
  if (fs.existsSync(localPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      mappingCache = new Map(Object.entries(data));
      console.log(`🗂️ Mapping cache: ${mappingCache.size} entries (local)`);
      return;
    } catch {}
  }

  // 2. R2
  const r2Data = await r2Get('mapping-cache.json');
  if (r2Data) {
    try {
      const data = JSON.parse(r2Data);
      mappingCache = new Map(Object.entries(data));
      fs.writeFileSync(localPath, r2Data, 'utf8');
      console.log(`☁️ Mapping cache: ${mappingCache.size} entries (R2)`);
      return;
    } catch {}
  }

  console.log('🗂️ Mapping cache: empty');
}

function saveMappingCache() {
  const obj = Object.fromEntries(mappingCache);
  const json = JSON.stringify(obj);
  try { fs.writeFileSync(path.join(DATA_DIR, 'mapping-cache.json'), json, 'utf8'); } catch {}
  r2Put('mapping-cache.json', json);
}

// ===== TVDB season+episode → AniDB ID + episode =====
function resolveViaTVDB(tvdbId, season, episode) {
  const entries = animeListsByTVDB.get(String(tvdbId));
  if (!entries) return null;

  const entry = entries.find(e => e.defaulttvdbseason === season);
  if (entry) {
    const anidbEpisode = episode + entry.episodeoffset;
    console.log(`  📋 anime-lists: TVDB ${tvdbId} S${season}E${episode} → AniDB ${entry.anidbid} ep${anidbEpisode} (offset ${entry.episodeoffset})`);
    return { anidbId: entry.anidbid, episode: anidbEpisode };
  }

  for (const e of entries) {
    for (const m of e.mappings) {
      if (m.tvdbseason === season) {
        const anidbEpisode = episode + m.offset;
        console.log(`  📋 anime-lists mapping: TVDB ${tvdbId} S${season}E${episode} → AniDB ${e.anidbid} ep${anidbEpisode}`);
        return { anidbId: e.anidbid, episode: anidbEpisode };
      }
    }
  }

  if (entries.length > 0) {
    console.log(`  📋 anime-lists fallback: AniDB ${entries[0].anidbid}`);
    return { anidbId: entries[0].anidbid, episode };
  }
  return null;
}

// ===== Main resolver: Stremio ID → AniDB ID =====
async function resolveToAniDB(type, fullId) {
  let platform, id;
  if (fullId.startsWith('kitsu:')) { platform = 'kitsu'; id = parseInt(fullId.split(':')[1]); }
  else if (fullId.startsWith('tvdb:')) { platform = 'tvdb'; id = fullId.split(':')[1]; }
  else if (fullId.startsWith('anilist:')) { platform = 'anilist'; id = parseInt(fullId.split(':')[1]); }
  else { platform = 'imdb'; id = fullId.split(':')[0]; }

  const cacheKey = `${platform}:${id}`;

  // 0. RAM cache
  if (mappingCache.has(cacheKey)) {
    const cached = mappingCache.get(cacheKey);
    if (cached.anidb) return cached;
  }

  // 1. anime-lists XML (IMDb→AniDB, instant)
  if (platform === 'imdb' && animeListsLoaded) {
    const entries = animeListsByIMDb.get(id);
    if (entries?.length) {
      const main = entries.find(e => e.defaulttvdbseason === 1) || entries[0];
      const offRec = offlineDB.byAniDB.get(main.anidbid);
      const record = { anidb: main.anidbid, tvdbId: main.tvdbid, title: offRec?.title || '', imdb: id };
      mappingCache.set(cacheKey, record);
      saveMappingCache();
      console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (anime-lists) "${record.title}"`);
      return record;
    }
  }

  // 1b. anime-lists XML (TVDB→AniDB, instant)
  if (platform === 'tvdb' && animeListsLoaded) {
    const entries = animeListsByTVDB.get(String(id));
    if (entries?.length) {
      const main = entries.find(e => e.defaulttvdbseason === 1) || entries[0];
      const offRec = offlineDB.byAniDB.get(main.anidbid);
      const record = { anidb: main.anidbid, tvdbId: String(id), title: offRec?.title || '', imdb: main.imdbid || '' };
      mappingCache.set(cacheKey, record);
      saveMappingCache();
      console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (anime-lists) "${record.title}"`);
      return record;
    }
  }

  // 1c. anime-offline-database (AniList→AniDB, instant)
  if (platform === 'anilist') {
    const offRec = offlineDB.byAniList.get(id);
    if (offRec?.anidb) {
      const record = { anidb: offRec.anidb, title: offRec.title || '', anilist: id };
      mappingCache.set(cacheKey, record);
      saveMappingCache();
      console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (offline-db) "${record.title}"`);
      return record;
    }
  }

  // 2. anime-offline-database (Kitsu/AniList/MAL→AniDB)
  let record = null;
  if (platform === 'kitsu') record = offlineDB.byKitsu.get(id);
  else if (platform === 'imdb') record = await resolveIMDbViaChain(type, id);

  if (record?.anidb) {
    mappingCache.set(cacheKey, record);
    saveMappingCache();
    console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (offline-db) "${record.title}"`);
    return record;
  }

  // 3. ids.moe (online)
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

async function resolveIMDbViaChain(type, imdbId) {
  try {
    const cineResp = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const meta = cineResp.data?.meta;
    if (!meta) return null;

    const tvdbId = meta.tvdb_id;
    const searchNames = new Set();
    if (meta.name) { searchNames.add(meta.name); searchNames.add(stripDiacritics(meta.name)); }
    if (meta.nameEn) searchNames.add(meta.nameEn);
    if (meta.aliases) for (const a of meta.aliases) searchNames.add(a);

    const gql = `query ($search: String) { Page(page:1, perPage:5) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } } } }`;

    for (const searchName of searchNames) {
      if (!searchName) continue;
      try {
        const alResp = await axios.post('https://graphql.anilist.co', { query: gql, variables: { search: searchName } }, { timeout: 8000 });
        const media = alResp.data?.data?.Page?.media;
        if (media?.length) {
          for (const m of media) {
            const record = offlineDB.byAniList.get(m.id);
            if (record?.anidb) return { ...record, title: meta.name || searchName, tvdbId };
          }
          const idsMoe = await queryIdsMoe('anilist', media[0].id);
          if (idsMoe?.anidb) return { ...idsMoe, title: meta.name || searchName, tvdbId };
        }
      } catch {}
    }
    return null;
  } catch { return null; }
}

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function queryIdsMoe(platform, id) {
  const pMap = { 'imdb': 'imdb', 'kitsu': 'kitsu', 'anilist': 'anilist', 'mal': 'mal', 'anidb': 'anidb' };
  if (!pMap[platform]) return null;
  try {
    const resp = await axios.get(`https://api.ids.moe/ids/${id}`, { params: { p: pMap[platform] }, timeout: 5000 });
    const d = resp.data;
    if (!d) return null;
    return { anidb: d.anidb || null, anilist: d.anilist || null, mal: d.myanimelist || null, kitsu: d.kitsu || null, title: d.title || '' };
  } catch { return null; }
}

// ===== Episode resolution for multi-season =====
async function resolveEpisode(type, fullId, season, episode) {
  if (season <= 1) return { anidbId: null, episode, season: 1 };
  if (fullId.startsWith('kitsu:')) return { anidbId: null, episode, season: 1 };

  const imdbId = fullId.split(':')[0];

  // 1. anime-lists (TVDB→AniDB per-season)
  if (animeListsLoaded) {
    try {
      const cineResp = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
      const tvdbId = cineResp.data?.meta?.tvdb_id;
      if (tvdbId) {
        const result = resolveViaTVDB(tvdbId, season, episode);
        if (result) return { anidbId: result.anidbId, episode: result.episode, season };
      }
    } catch {}
  }

  // 2. Cinemeta offset fallback
  try {
    const cineResp = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { timeout: 8000 });
    const videos = cineResp.data?.meta?.videos || [];
    let offset = 0;
    for (let s = 1; s < season; s++) offset += videos.filter(v => v.season === s).length;
    if (offset > 0) {
      const abs = offset + episode;
      console.log(`  📺 Cinemeta offset: S${season}E${episode} → absolute ep ${abs} (offset ${offset})`);
      return { anidbId: null, episode: abs, season };
    }
  } catch {}

  console.log(`  📺 No season mapping, using S${season}E${episode} as-is`);
  return { anidbId: null, episode, season };
}

// ===== Parse Stremio ID =====
function parseEpisodeAndSeason(fullId) {
  const parts = fullId.split(':');
  if (fullId.startsWith('at:')) {
    return { season: parseInt(parts[2]) || 1, episode: parseInt(parts[3]) || 1 };
  }
  if (fullId.startsWith('kitsu:')) {
    if (parts.length >= 4) return { season: parseInt(parts[2]) || 1, episode: parseInt(parts[3]) || 1 };
    return { season: 1, episode: parseInt(parts[2]) || 1 };
  }
  if (fullId.startsWith('tvdb:')) return { season: parseInt(parts[2]) || 1, episode: parseInt(parts[3]) || 1 };
  if (fullId.startsWith('anilist:')) return { season: parseInt(parts[2]) || 1, episode: parseInt(parts[3]) || 1 };
  if (parts.length >= 3) return { season: parseInt(parts[1]) || 1, episode: parseInt(parts[2]) || 1 };
  return { season: 1, episode: parseInt(parts[1]) || 1 };
}

// ===== Get TVDB ID for AniDB ID =====
function getTVDBForAniDB(anidbId) {
  const entry = animeListsByAniDB.get(String(anidbId));
  return entry?.tvdbid || null;
}

// ===== Weekly update (Sunday 4:00 AM) =====
async function weeklyUpdate() {
  console.log('📦 Weekly update starting...');

  // Re-download anime-offline-database
  await downloadOfflineDB();

  // Re-download anime-lists
  const localPath = path.join(DATA_DIR, 'anime-list.xml');
  try { fs.unlinkSync(localPath); } catch {}
  await loadAnimeLists();

  console.log('📦 Weekly update complete');
}

module.exports = {
  loadOfflineDB, loadAnimeLists, loadMappingCache,
  resolveToAniDB, resolveEpisode, resolveViaTVDB, parseEpisodeAndSeason,
  weeklyUpdate, offlineDB,
  getTVDBFromAniDB: (anidbId) => {
    const entry = animeListsByAniDB.get(String(anidbId));
    return entry?.tvdbid || null;
  },
  getTVDBInfoFromAniDB: (anidbId) => {
    const entry = animeListsByAniDB.get(String(anidbId));
    if (!entry) return null;
    return { tvdbId: entry.tvdbid, season: entry.defaulttvdbseason || 1, offset: entry.episodeoffset || 0 };
  },
  resolveFromAniList: (anilistId) => {
    const rec = offlineDB.byAniList.get(anilistId);
    return rec || null;
  }
};
