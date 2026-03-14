const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ===== anime-offline-database (40k anime, RAM indexed) =====
let offlineDB = {
  byAniDB: new Map(), byAniList: new Map(), byMAL: new Map(), byKitsu: new Map(),
  loaded: false
};

// ===== anime-lists: TVDB→AniDB per-season mapping =====
// Key: tvdbid → [{ anidbid, defaulttvdbseason, episodeoffset, mappings }]
let animeListsByTVDB = new Map();
let animeListsByIMDb = new Map(); // imdbid → [entries]
let animeListsByAniDB = new Map(); // anidbid → entry
let animeListsLoaded = false;

// ===== RAM mapping cache (not persisted to R2 for now) =====
let mappingCache = new Map();

// ===== Load anime-offline-database =====
async function loadOfflineDB() {
  const localPath = path.join(DATA_DIR, 'anime-offline-database-minified.json');

  if (fs.existsSync(localPath)) {
    try {
      console.log('📦 Loading anime-offline-database from local...');
      const raw = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      indexOfflineDB(raw.data || []);
      console.log(`📦 Indexed ${offlineDB.byAniDB.size} AniDB, ${offlineDB.byAniList.size} AniList entries`);
      return;
    } catch (err) { console.error('📦 Parse error:', err.message); }
  }

  await downloadOfflineDB();
}

async function downloadOfflineDB() {
  const localPath = path.join(DATA_DIR, 'anime-offline-database-minified.json');
  console.log('⬇️ Downloading anime-offline-database from GitHub releases...');
  try {
    const resp = await axios.get(
      'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json',
      { timeout: 120000, responseType: 'text', maxContentLength: 200 * 1024 * 1024 }
    );
    fs.writeFileSync(localPath, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data), 'utf8');
    const raw = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    indexOfflineDB(raw.data || []);
    console.log(`⬇️ Indexed ${offlineDB.byAniDB.size} AniDB, ${offlineDB.byAniList.size} AniList entries`);
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

// ===== Load anime-lists XML (TVDB↔AniDB per-season mapping) =====
async function loadAnimeLists() {
  const localPath = path.join(DATA_DIR, 'anime-list.xml');

  let xml = '';
  if (fs.existsSync(localPath)) {
    xml = fs.readFileSync(localPath, 'utf8');
    console.log('📋 Loaded anime-lists from local');
  } else {
    console.log('⬇️ Downloading anime-lists XML...');
    try {
      const resp = await axios.get(
        'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml',
        { timeout: 30000, responseType: 'text' }
      );
      xml = resp.data || '';
      fs.writeFileSync(localPath, xml, 'utf8');
      console.log('⬇️ Downloaded anime-lists XML');
    } catch (err) {
      console.error('⬇️ anime-lists download failed:', err.message);
      return;
    }
  }

  parseAnimeLists(xml);
}

function parseAnimeLists(xml) {
  // Simple regex-based XML parser for anime-list entries
  // Format: <anime anidbid="123" tvdbid="456" defaulttvdbseason="1" episodeoffset="0" tmdbid="" imdbid="">
  const entryRegex = /<anime\s+([^>]+)>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;

  animeListsByTVDB.clear();
  animeListsByIMDb.clear();
  animeListsByAniDB.clear();
  let count = 0;

  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const attrs = {};
    let am;
    while ((am = attrRegex.exec(match[1])) !== null) {
      attrs[am[1]] = am[2];
    }
    attrRegex.lastIndex = 0;

    const anidbid = parseInt(attrs.anidbid);
    const tvdbid = attrs.tvdbid;
    const defaulttvdbseason = parseInt(attrs.defaulttvdbseason) || 1;
    const episodeoffset = parseInt(attrs.episodeoffset) || 0;
    const imdbid = attrs.imdbid || '';

    if (!anidbid || !tvdbid || tvdbid === 'unknown') continue;

    // Extract mapping-list if present (between this <anime> and next </anime>)
    const entryStart = match.index;
    const entryEnd = xml.indexOf('</anime>', entryStart);
    const entryXml = entryEnd > entryStart ? xml.substring(entryStart, entryEnd) : '';

    // Parse individual episode mappings
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
        text: mm[2] || '' // individual episode mappings like ";1-5;2-6;"
      });
    }

    const entry = { anidbid, tvdbid, defaulttvdbseason, episodeoffset, imdbid, mappings };

    if (!animeListsByTVDB.has(tvdbid)) animeListsByTVDB.set(tvdbid, []);
    animeListsByTVDB.get(tvdbid).push(entry);

    // Index by IMDb ID
    if (imdbid && imdbid.startsWith('tt')) {
      if (!animeListsByIMDb.has(imdbid)) animeListsByIMDb.set(imdbid, []);
      animeListsByIMDb.get(imdbid).push(entry);
    }

    // Index by AniDB ID
    animeListsByAniDB.set(String(anidbid), entry);

    count++;
  }

  animeListsLoaded = true;
  console.log(`📋 Parsed ${count} anime-lists entries (${animeListsByTVDB.size} TVDB, ${animeListsByIMDb.size} IMDb)`);
}

// ===== Resolve TVDB season+episode → AniDB ID + episode number =====
function resolveViaTVDB(tvdbId, season, episode) {
  const entries = animeListsByTVDB.get(String(tvdbId));
  if (!entries) return null;

  // Find the entry for this TVDB season
  // Each anime-lists entry has defaulttvdbseason = which TVDB season this AniDB entry covers
  const entry = entries.find(e => e.defaulttvdbseason === season);

  if (entry) {
    // episodeoffset: AniDB episode = TVDB episode - episodeoffset
    // Typically episodeoffset is used when S02 starts at ep1 in TVDB but continues AniDB numbering
    const anidbEpisode = episode + entry.episodeoffset;
    console.log(`  📋 anime-lists: TVDB ${tvdbId} S${season}E${episode} → AniDB ${entry.anidbid} ep${anidbEpisode} (offset ${entry.episodeoffset})`);
    return { anidbId: entry.anidbid, episode: anidbEpisode };
  }

  // Check mappings for non-standard season mappings
  for (const e of entries) {
    for (const m of e.mappings) {
      if (m.tvdbseason === season) {
        const anidbEpisode = episode + m.offset;
        console.log(`  📋 anime-lists mapping: TVDB ${tvdbId} S${season}E${episode} → AniDB ${e.anidbid} ep${anidbEpisode} (mapping offset ${m.offset})`);
        return { anidbId: e.anidbid, episode: anidbEpisode };
      }
    }
  }

  // Fallback: first entry (might be wrong for multi-season)
  if (entries.length > 0) {
    const e = entries[0];
    console.log(`  📋 anime-lists fallback: using AniDB ${e.anidbid} for TVDB ${tvdbId}`);
    return { anidbId: e.anidbid, episode };
  }

  return null;
}

// ===== Main resolver: Stremio ID → AniDB ID =====
async function resolveToAniDB(type, fullId) {
  let platform, id;
  if (fullId.startsWith('kitsu:')) {
    platform = 'kitsu';
    id = parseInt(fullId.split(':')[1]);
  } else if (fullId.startsWith('tt')) {
    platform = 'imdb';
    id = fullId.split(':')[0];
  } else {
    platform = 'imdb';
    id = fullId.split(':')[0];
  }

  const cacheKey = `${platform}:${id}`;

  // 0. RAM cache
  if (mappingCache.has(cacheKey)) {
    const cached = mappingCache.get(cacheKey);
    if (cached.anidb) return cached;
  }

  // 1. anime-lists XML (RAM, instant) — best for IMDb
  if (platform === 'imdb' && animeListsLoaded) {
    const entries = animeListsByIMDb.get(id);
    if (entries?.length) {
      // Pick the first/main entry (defaulttvdbseason=1 or first available)
      const main = entries.find(e => e.defaulttvdbseason === 1) || entries[0];
      const record = { anidb: main.anidbid, tvdbId: main.tvdbid, title: '', imdb: id };
      // Try to get title from offline DB
      const offRec = offlineDB.byAniDB.get(main.anidbid);
      if (offRec) record.title = offRec.title;
      mappingCache.set(cacheKey, record);
      console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (anime-lists) "${record.title}"`);
      return record;
    }
  }

  // 2. anime-offline-database (RAM, instant)
  let record = null;
  if (platform === 'kitsu') record = offlineDB.byKitsu.get(id);
  else if (platform === 'mal') record = offlineDB.byMAL.get(id);
  else if (platform === 'anilist') record = offlineDB.byAniList.get(id);

  // For IMDb: try Cinemeta → AniList → offline DB
  if (!record && platform === 'imdb') {
    record = await resolveIMDbViaChain(type, id);
  }

  if (record?.anidb) {
    mappingCache.set(cacheKey, record);
    console.log(`  🆔 ${cacheKey} → AniDB ${record.anidb} (offline-db) "${record.title}"`);
    return record;
  }

  // 3. ids.moe API (online fallback)
  const idsMoeResult = await queryIdsMoe(platform, id);
  if (idsMoeResult?.anidb) {
    mappingCache.set(cacheKey, idsMoeResult);
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
    const name = meta?.name;
    if (!name) return null;

    // Store TVDB ID for later season resolution
    const tvdbId = meta?.tvdb_id;

    // AniList lookup
    const gql = `query ($search: String) { Page(page:1, perPage:5) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } } } }`;
    const alResp = await axios.post('https://graphql.anilist.co', { query: gql, variables: { search: name } }, { timeout: 8000 });
    const media = alResp.data?.data?.Page?.media;

    if (media?.length) {
      for (const m of media) {
        const record = offlineDB.byAniList.get(m.id);
        if (record?.anidb) return { ...record, title: name, tvdbId };
      }
      // ids.moe with AniList
      const idsMoe = await queryIdsMoe('anilist', media[0].id);
      if (idsMoe?.anidb) return { ...idsMoe, title: name, tvdbId };
    }
    return null;
  } catch { return null; }
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

// ===== Resolve episode for multi-season anime =====
async function resolveEpisode(type, fullId, season, episode) {
  // S01 → no conversion needed
  if (season <= 1) return { anidbId: null, episode, season: 1 };

  // Kitsu: already absolute
  if (fullId.startsWith('kitsu:')) return { anidbId: null, episode, season: 1 };

  const imdbId = fullId.split(':')[0];

  // Method 1: anime-lists (TVDB→AniDB per-season)
  if (animeListsLoaded) {
    // Get TVDB ID from Cinemeta
    try {
      const cineResp = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
      const tvdbId = cineResp.data?.meta?.tvdb_id;

      if (tvdbId) {
        const result = resolveViaTVDB(tvdbId, season, episode);
        if (result) return { anidbId: result.anidbId, episode: result.episode, season };
      }
    } catch {}
  }

  // Method 2: Cinemeta episode count offset
  try {
    const cineResp = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { timeout: 8000 });
    const videos = cineResp.data?.meta?.videos || [];
    let offset = 0;
    for (let s = 1; s < season; s++) {
      offset += videos.filter(v => v.season === s).length;
    }
    if (offset > 0) {
      const abs = offset + episode;
      console.log(`  📺 Cinemeta offset: S${season}E${episode} → absolute ep ${abs} (offset ${offset})`);
      return { anidbId: null, episode: abs, season };
    }
  } catch {}

  console.log(`  📺 No season mapping, using S${season}E${episode} as-is`);
  return { anidbId: null, episode, season };
}

// ===== Parse episode/season from Stremio ID =====
function parseEpisodeAndSeason(fullId) {
  const parts = fullId.split(':');
  if (fullId.startsWith('kitsu:')) return { season: 1, episode: parseInt(parts[2]) || 1 };
  if (parts.length >= 3) return { season: parseInt(parts[1]) || 1, episode: parseInt(parts[2]) || 1 };
  return { season: 1, episode: parseInt(parts[1]) || 1 };
}

// ===== Weekly updates =====
async function weeklyUpdate() {
  console.log('📦 Weekly update...');
  await downloadOfflineDB();
  // Re-download anime-lists
  const localPath = path.join(DATA_DIR, 'anime-list.xml');
  try { fs.unlinkSync(localPath); } catch {}
  await loadAnimeLists();
}

async function loadMappingCache() {
  console.log('🗂️ Mapping cache: RAM only (R2 disabled)');
}

module.exports = {
  loadOfflineDB, loadAnimeLists, loadMappingCache,
  resolveToAniDB, resolveEpisode, parseEpisodeAndSeason,
  weeklyUpdate, offlineDB
};
