const express = require('express');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');
const axios = require('axios');

const config = require('./lib/config');
const { getTodayAnime } = require('./lib/anilist');
const { loadOfflineDB, loadAnimeLists, loadMappingCache, resolveToAniDB, resolveEpisode, resolveViaTVDB, parseEpisodeAndSeason, weeklyUpdate, offlineDB, getTVDBFromAniDB, getTVDBInfoFromAniDB } = require('./lib/idmap');
const { searchByAniDBId, searchByText, detectQuality, sortByGroupPriority, loadEidCache, DEFAULT_GROUPS, DEFAULT_RESOLUTIONS } = require('./lib/search');
const { getRDStream, rdInProgress, getCacheKey, serveLoadingVideo, DOWNLOADING_VIDEO_URL, checkInstantAvailability } = require('./lib/realdebrid');
const { generateAllPosters, formatTimeCET } = require('./lib/posters');
const { startRssFetcher, clearRssIndex, searchRssIndex, getRssStats } = require('./lib/rss');
const { getTBStatus, getTBStream, getTBNZBStream } = require('./lib/torbox');

process.on('uncaughtException', (err) => { console.error('⚠️ Uncaught:', err.message); console.error(err.stack); });
process.on('unhandledRejection', (err) => { console.error('⚠️ Unhandled:', err?.message || err); });

const PORT = process.env.PORT || 3002;
const BASE_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

console.log('═══════════════════════════════════════════');
console.log('  🎬 Nyaa + Anime Today v5.0');
console.log('═══════════════════════════════════════════');
console.log(`  PORT: ${PORT}`);
console.log(`  URL:  ${BASE_URL}`);

// ===== State =====
let todayAnimeCache = [];

// ===== Cache update =====
async function updateCache() {
  console.log('🔄 Updating anime cache...');
  const t0 = Date.now();
  try {
    const schedules = await getTodayAnime();
    await generateAllPosters(schedules);
    todayAnimeCache = schedules;
    console.log(`✅ Cache: ${todayAnimeCache.length} anime (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) { console.error('❌ Cache failed:', err.message); }
}

cron.schedule('0 4 * * *', () => { clearRssIndex(); updateCache(); });

// ===== Magnet store (for clean RD stream URLs) =====
const magnetStore = new Map();
const nzbStore = new Map();
function storeMagnet(magnet) {
  const hash = crypto.createHash('md5').update(magnet).digest('hex');
  magnetStore.set(hash, magnet);
  return hash;
}
function storeNZB(nzbUrl, torrentName) {
  const hash = crypto.createHash('md5').update(nzbUrl).digest('hex');
  nzbStore.set(hash, { url: nzbUrl, name: torrentName });
  return hash;
}

// ===== Express =====
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ===== User middleware =====
function getUserFromToken(token) {
  return config.getUser(token);
}

// ===== Landing page =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== USER API =====
app.post('/api/user/create', (req, res) => {
  const { token, data } = config.createUser();
  res.json({ token, user: data });
});

app.get('/api/user/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    hidden_anime: user.hidden_anime,
    has_rd: !!user.rd_api_key,
    created: user.created,
  });
});

// ===== RD OAuth =====
app.get('/api/rd/device-code', async (req, res) => {
  try {
    const resp = await axios.get('https://api.real-debrid.com/oauth/v2/device/code', {
      params: { client_id: config.RD_OPEN_SOURCE_CLIENT_ID, new_credentials: 'yes' }, timeout: 10000
    });
    res.json(resp.data);
  } catch (err) { res.status(500).json({ error: 'RD device code failed' }); }
});

app.get('/api/rd/poll-auth', async (req, res) => {
  const { device_code, token } = req.query;
  if (!device_code || !token) return res.status(400).json({ error: 'Missing params' });

  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const resp = await axios.get('https://api.real-debrid.com/oauth/v2/device/credentials', {
      params: { client_id: config.RD_OPEN_SOURCE_CLIENT_ID, code: device_code }, timeout: 10000
    });
    const tokenResp = await axios.post('https://api.real-debrid.com/oauth/v2/token',
      `client_id=${resp.data.client_id}&client_secret=${resp.data.client_secret}&code=${device_code}&grant_type=http://oauth.net/grant_type/device/1.0`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });

    user.rd_api_key = tokenResp.data.access_token;
    user.rd_refresh_token = tokenResp.data.refresh_token;
    user.rd_client_id = resp.data.client_id;
    user.rd_client_secret = resp.data.client_secret;
    config.saveUser(token, user);
    console.log(`✅ RD connected for ${token}`);
    res.json({ status: 'authorized' });
  } catch (err) {
    if (err.response?.status === 403) return res.json({ status: 'pending' });
    res.status(500).json({ error: 'Auth failed' });
  }
});

app.post('/api/rd/save-key', (req, res) => {
  const { token, key } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });

  axios.get('https://api.real-debrid.com/rest/1.0/user', {
    headers: { 'Authorization': `Bearer ${key}` }, timeout: 10000
  }).then(resp => {
    user.rd_api_key = key;
    user.rd_refresh_token = ''; user.rd_client_id = ''; user.rd_client_secret = '';
    config.saveUser(token, user);
    res.json({ success: true, username: resp.data.username, premium: resp.data.premium > 0 });
  }).catch(() => res.json({ success: false }));
});

app.get('/api/rd/status/:token', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user || !user.rd_api_key) return res.json({ connected: false });

  try {
    const resp = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
      headers: { 'Authorization': `Bearer ${user.rd_api_key}` }, timeout: 10000
    });
    res.json({ connected: true, username: resp.data.username, premium: resp.data.premium > 0, expiration: resp.data.expiration });
  } catch {
    // Try refresh
    if (user.rd_refresh_token && user.rd_client_id && user.rd_client_secret) {
      try {
        const r = await axios.post('https://api.real-debrid.com/oauth/v2/token',
          `client_id=${user.rd_client_id}&client_secret=${user.rd_client_secret}&code=${user.rd_refresh_token}&grant_type=http://oauth.net/grant_type/device/1.0`,
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
        user.rd_api_key = r.data.access_token;
        user.rd_refresh_token = r.data.refresh_token;
        config.saveUser(req.params.token, user);
        const retry = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
          headers: { 'Authorization': `Bearer ${user.rd_api_key}` }, timeout: 10000 });
        return res.json({ connected: true, username: retry.data.username, premium: retry.data.premium > 0, expiration: retry.data.expiration });
      } catch {}
    }
    res.json({ connected: false });
  }
});

app.post('/api/rd/disconnect/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.rd_api_key = ''; user.rd_refresh_token = ''; user.rd_client_id = ''; user.rd_client_secret = '';
  config.saveUser(req.params.token, user);
  res.json({ success: true });
});

// ===== TMDB =====
app.post('/api/tmdb/save', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    await axios.get('https://api.themoviedb.org/3/configuration', { params: { api_key: key }, timeout: 5000 });
    config.setTMDBKey(key);
    console.log('✅ TMDB key saved');
    updateCache();
    res.json({ valid: true, saved: true });
  } catch { res.json({ valid: false }); }
});

app.get('/api/tmdb/status', (req, res) => res.json({ configured: !!config.getTMDBKey() }));

// ===== Anime hide/show =====
app.get('/api/anime', (req, res) => {
  const token = req.query.token;
  const user = token ? config.getUser(token) : null;
  const hidden = user?.hidden_anime || [];
  res.json({
    count: todayAnimeCache.length,
    anime: todayAnimeCache.map(s => ({
      id: s.media.id, episode: s.episode, airingAt: s.airingAt,
      title: s.media.title, genres: s.media.genres, score: s.media.averageScore,
      poster: s.tmdbImages?.poster || s.media.coverImage?.extraLarge,
      hidden: hidden.includes(s.media.id)
    }))
  });
});

app.post('/api/anime/hide', (req, res) => {
  const { token, mediaId } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const id = parseInt(mediaId);
  if (!user.hidden_anime.includes(id)) { user.hidden_anime.push(id); config.saveUser(token, user); }
  res.json({ success: true });
});

app.post('/api/anime/show', (req, res) => {
  const { token, mediaId } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.hidden_anime = user.hidden_anime.filter(x => x !== parseInt(mediaId));
  config.saveUser(token, user);
  res.json({ success: true });
});

app.post('/api/refresh', async (req, res) => {
  await updateCache();
  res.json({ success: true, count: todayAnimeCache.length });
});

// ===== Sort Preferences API =====
app.get('/api/sort-prefs/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.json({});
  res.json({
    customSortEnabled: user.customSortEnabled || false,
    groupPriority: user.groupPriority || DEFAULT_GROUPS,
    resPriority: user.resPriority || DEFAULT_RESOLUTIONS,
    excludedResolutions: user.excludedResolutions || [],
    sortBySeeders: user.sortBySeeders !== false,
    defaultGroups: DEFAULT_GROUPS,
    defaultResolutions: DEFAULT_RESOLUTIONS
  });
});

app.post('/api/sort-prefs/:token', express.json(), (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { customSortEnabled, groupPriority, resPriority, excludedResolutions, sortBySeeders } = req.body;
  if (typeof customSortEnabled === 'boolean') user.customSortEnabled = customSortEnabled;
  if (Array.isArray(groupPriority)) user.groupPriority = groupPriority;
  if (Array.isArray(resPriority)) user.resPriority = resPriority;
  if (Array.isArray(excludedResolutions)) user.excludedResolutions = excludedResolutions;
  if (typeof sortBySeeders === 'boolean') user.sortBySeeders = sortBySeeders;
  config.saveUser(req.params.token, user);
  res.json({ success: true });
});

// ===== TorBox API =====
app.post('/api/torbox/save-key', express.json(), async (req, res) => {
  const { token, key } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const status = await getTBStatus(key);
  if (!status) return res.json({ success: false, error: 'Invalid API key' });
  user.tb_api_key = key;
  user.tb_use_torrents = user.tb_use_torrents ?? false;
  user.tb_use_nzb = user.tb_use_nzb ?? true;
  config.saveUser(token, user);
  res.json({ success: true, ...status });
});

app.get('/api/torbox/status/:token', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.tb_api_key) return res.json({ connected: false });
  const status = await getTBStatus(user.tb_api_key);
  if (!status) return res.json({ connected: false });
  res.json({ connected: true, ...status, tb_use_torrents: user.tb_use_torrents ?? false, tb_use_nzb: user.tb_use_nzb ?? true });
});

app.post('/api/torbox/disconnect/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (user) { delete user.tb_api_key; delete user.tb_use_torrents; delete user.tb_use_nzb; config.saveUser(req.params.token, user); }
  res.json({ success: true });
});

app.post('/api/torbox/toggle', express.json(), (req, res) => {
  const { token, field, value } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (field === 'tb_use_torrents') user.tb_use_torrents = !!value;
  if (field === 'tb_use_nzb') user.tb_use_nzb = !!value;
  config.saveUser(token, user);
  res.json({ success: true });
});

// ===== RD PLAY PROXY (shared by both addons) =====
app.get('/:token/play/:hash/:episode/video.mp4', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.rd_api_key) return serveLoadingVideo(res);

  const magnet = magnetStore.get(req.params.hash);
  if (!magnet) return serveLoadingVideo(res);

  const episode = parseInt(req.params.episode) || 0;
  const cacheKey = getCacheKey(magnet, user.rd_api_key) + (episode ? `_ep${episode}` : '');

  // Already in progress
  if (rdInProgress.has(cacheKey)) return serveLoadingVideo(res);

  rdInProgress.add(cacheKey);

  const timeoutP = new Promise(r => setTimeout(() => r(null), 8000));
  const rdP = getRDStream(magnet, user.rd_api_key, episode);
  const url = await Promise.race([rdP, timeoutP]);

  if (url) {
    rdInProgress.delete(cacheKey);
    return res.redirect(302, url);
  }

  // Serve loading video, let RD finish in background
  serveLoadingVideo(res);
  rdP.then(u => { if (u) console.log('  RD: ✅ Background done, cached'); })
    .catch(() => {}).finally(() => rdInProgress.delete(cacheKey));
});

// ===== TB PLAY PROXY =====
app.get('/:token/play-tb/:hash/:episode/video.mp4', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.tb_api_key) return serveLoadingVideo(res);

  const magnet = magnetStore.get(req.params.hash);
  if (!magnet) return serveLoadingVideo(res);

  const episode = parseInt(req.params.episode) || 0;
  const url = await getTBStream(magnet, user.tb_api_key, episode);
  if (url) return res.redirect(302, url);
  serveLoadingVideo(res);
});

// ===== NZB PLAY PROXY =====
app.get('/:token/play-nzb/:hash/:episode/video.mp4', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.tb_api_key) return serveLoadingVideo(res);

  const nzb = nzbStore.get(req.params.hash);
  if (!nzb) return serveLoadingVideo(res);

  const episode = parseInt(req.params.episode) || 0;
  const url = await getTBNZBStream(nzb.url, user.tb_api_key, episode, nzb.name);
  if (url) return res.redirect(302, url);
  serveLoadingVideo(res);
});

// ===== STREMIO: ANIME TODAY ADDON =====
app.get('/:token/today/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nyaa.anime.today.v7',
    version: '7.0.0',
    name: 'Anime Today',
    description: 'Dnešní anime z AniList — katalog s postery a epizodami.',
    logo: `${BASE_URL}/logo.png`,
    resources: ['catalog', 'meta'],
    types: ['series'],
    catalogs: [{ type: 'series', id: 'anime-today', name: 'Dnešní Anime', extra: [{ name: 'skip', isRequired: false }] }],
    idPrefixes: ['at:'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

app.get('/:token/today/catalog/:type/:id.json', (req, res) => {
  console.log(`=== TODAY CATALOG === type=${req.params.type} id=${req.params.id}`);
  if (req.params.id !== 'anime-today') return res.json({ metas: [] });
  const user = config.getUser(req.params.token);
  const hidden = user?.hidden_anime || [];

  const sorted = [...todayAnimeCache]
    .filter(s => !hidden.includes(s.media.id))
    .sort((a, b) => a.airingAt - b.airingAt);

  res.json({
    metas: sorted.map(s => {
      const m = s.media;
      let poster = s.generatedPoster ? `${BASE_URL}${s.generatedPoster}` : (s.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large);
      if (!poster || poster === 'null') poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
      const bg = m.bannerImage || s.tmdbImages?.backdrop || poster;
      const time = formatTimeCET(s.airingAt);
      const offRec = offlineDB.byAniList.get(m.id);
      // Always use at: prefix — our meta endpoint provides episodes
      const id = `at:${m.id}`;
      return {
        id, type: 'series',
        name: m.title.romaji || m.title.english || m.title.native,
        poster, background: bg || poster,
        description: `${time} · Epizoda ${s.episode}\n\n${(m.description || '').replace(/<[^>]*>/g, '')}`,
        genres: m.genres || [],
        releaseInfo: `${time} · ${m.season || ''} ${m.seasonYear || ''} · Ep ${s.episode}`.trim(),
        imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined
      };
    })
  });
});

// ===== STREMIO: ANIME TODAY META ENDPOINT =====
const cinemetaCache = new Map();
const CINEMETA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function getCinemetaMeta(imdbId) {
  const cached = cinemetaCache.get(imdbId);
  if (cached && Date.now() - cached.ts < CINEMETA_CACHE_TTL) return cached.data;
  try {
    const resp = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { timeout: 8000 });
    const meta = resp.data?.meta;
    if (meta) { cinemetaCache.set(imdbId, { data: meta, ts: Date.now() }); }
    return meta || null;
  } catch { return null; }
}

app.get('/:token/today/meta/:type/:id.json', async (req, res) => {
  const atId = req.params.id; // at:187941
  const type = req.params.type;
  console.log(`=== META === type=${type} id=${atId}`);

  if (!atId.startsWith('at:')) return res.json({ meta: null });

  const anilistId = parseInt(atId.split(':')[1]);
  if (!anilistId) return res.json({ meta: null });

  const schedule = todayAnimeCache.find(s => s.media.id === anilistId);
  const m = schedule?.media;
  const offRec = offlineDB.byAniList.get(anilistId);
  const imdbId = offRec?.imdb;

  console.log(`  🔍 AniList: ${anilistId}, IMDb: ${imdbId || 'none'}, schedule: ${schedule ? 'yes' : 'no'}`);

  // === Strategy 1: IMDb exists → return Cinemeta meta with tt: video IDs ===
  // Stremio will then send tt:season:episode to Nyaa Search stream endpoint
  if (imdbId) {
    const cinemeta = await getCinemetaMeta(imdbId);
    if (cinemeta) {
      // Use Cinemeta meta as base but keep our at: ID and our poster
      let poster = schedule?.generatedPoster ? `${BASE_URL}${schedule.generatedPoster}` : (schedule?.tmdbImages?.poster || cinemeta.poster || m?.coverImage?.extraLarge);
      if (!poster || poster === 'null') poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';

      const meta = {
        id: atId,
        type: 'series',
        name: cinemeta.name || m?.title?.romaji || offRec?.title || 'Unknown',
        poster,
        background: cinemeta.background || m?.bannerImage || schedule?.tmdbImages?.backdrop || poster,
        description: cinemeta.description || (m?.description || '').replace(/<[^>]*>/g, ''),
        genres: cinemeta.genres || m?.genres || [],
        releaseInfo: cinemeta.releaseInfo || '',
        imdbRating: cinemeta.imdbRating || (m?.averageScore ? (m.averageScore / 10).toFixed(1) : undefined),
        // Keep original tt: video IDs — Stremio sends these to Nyaa Search
        videos: cinemeta.videos || [],
        logo: cinemeta.logo,
        runtime: cinemeta.runtime,
      };

      console.log(`  📤 Meta (Cinemeta): ${meta.name} — ${(meta.videos || []).length} videos with tt: IDs`);
      return res.json({ meta });
    }
    console.log(`  ⚠️ Cinemeta fetch failed for ${imdbId}, using fallback`);
  }

  // === Strategy 2: No IMDb → generate episodes with at: IDs ===
  const currentEp = schedule?.episode || offRec?.episodes || 1;
  const totalEp = m?.episodes || currentEp;
  const epCount = Math.max(currentEp, totalEp);

  console.log(`  📺 Generating ${epCount} episodes (no IMDb, using at: IDs)`);

  const videos = [];
  for (let ep = 1; ep <= epCount; ep++) {
    videos.push({
      id: `at:${anilistId}:1:${ep}`,
      title: `Episode ${ep}`,
      season: 1,
      episode: ep,
      released: schedule ? new Date((schedule.airingAt - (currentEp - ep) * 7 * 24 * 3600) * 1000).toISOString() : undefined,
    });
  }

  let poster = schedule?.generatedPoster ? `${BASE_URL}${schedule.generatedPoster}` : (schedule?.tmdbImages?.poster || m?.coverImage?.extraLarge || m?.coverImage?.large);
  if (!poster || poster === 'null') poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
  const bg = m?.bannerImage || schedule?.tmdbImages?.backdrop || poster;
  const time = schedule ? formatTimeCET(schedule.airingAt) : '';

  const meta = {
    id: atId,
    type: 'series',
    name: m?.title?.romaji || m?.title?.english || m?.title?.native || offRec?.title || 'Unknown',
    poster,
    background: bg || poster,
    description: schedule ? `${time} · Epizoda ${schedule.episode}\n\n${(m?.description || '').replace(/<[^>]*>/g, '')}` : (offRec?.title || ''),
    genres: m?.genres || [],
    releaseInfo: schedule ? `${time} · ${m?.season || ''} ${m?.seasonYear || ''} · Ep ${schedule.episode}`.trim() : '',
    imdbRating: m?.averageScore ? (m.averageScore / 10).toFixed(1) : undefined,
    videos,
  };

  console.log(`  📤 Meta (fallback): ${meta.name} — ${videos.length} videos with at: IDs`);
  res.json({ meta });
});

// ===== STREMIO: NYAA SEARCH ADDON =====
app.get('/:token/nyaa/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nyaa.search.v6',
    version: '6.0.0',
    name: 'Nyaa Search',
    description: 'Anime z Nyaa.si + RealDebrid. Funguje s Cinemeta/Kitsu/Anime Today.',
    logo: `${BASE_URL}/logo-nyaa.png`,
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['at:', 'kitsu:', 'tt', 'tvdb:', 'anilist:'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

app.get('/:token/nyaa/stream/:type/:id.json', async (req, res) => {
  const token = req.params.token;
  const type = req.params.type;
  const fullId = req.params.id;
  const user = config.getUser(token);
  const isMovie = type === 'movie';

  console.log(`=== STREAM === type=${type} id=${fullId}`);

  let { season, episode } = parseEpisodeAndSeason(fullId);
  let torrents = [];

  // Detect if episode was explicitly provided in the ID
  const idParts = fullId.split(':');
  const hasExplicitEpisode = fullId.startsWith('at:') ? idParts.length >= 4 :
    fullId.startsWith('kitsu:') ? idParts.length >= 4 :
    fullId.startsWith('tt') ? idParts.length >= 3 :
    fullId.startsWith('anilist:') ? idParts.length >= 4 :
    fullId.startsWith('tvdb:') ? idParts.length >= 4 : idParts.length >= 3;

  // If no explicit episode, check todayAnimeCache for correct episode
  if (!hasExplicitEpisode && !isMovie) {
    const imdbBase = fullId.startsWith('tt') ? idParts[0] : null;
    const kitsuId = fullId.startsWith('kitsu:') ? parseInt(idParts[1]) : null;
    const anilistIdNum = fullId.startsWith('anilist:') ? parseInt(idParts[1]) : null;

    // For IMDb: also try resolving to AniDB first, then match by AniDB in cache
    let matchedByImdb = false;
    if (imdbBase) {
      // 1. Try direct IMDb match in offline-db
      for (const s of todayAnimeCache) {
        const rec = offlineDB.byAniList.get(s.media.id);
        if (rec?.imdb === imdbBase) { episode = s.episode; season = 1; matchedByImdb = true; console.log(`  📅 Today (imdb): ${imdbBase} → ep${episode}`); break; }
      }
      // 2. Fallback: resolve IMDb → AniDB via anime-lists, then match AniDB in cache
      if (!matchedByImdb) {
        try {
          const resolved = await resolveToAniDB('series', imdbBase);
          if (resolved?.anidb) {
            for (const s of todayAnimeCache) {
              const rec = offlineDB.byAniList.get(s.media.id);
              if (rec?.anidb === resolved.anidb) { episode = s.episode; season = 1; matchedByImdb = true; console.log(`  📅 Today (anidb): ${imdbBase} → AniDB ${resolved.anidb} → ep${episode}`); break; }
            }
          }
        } catch {}
      }
    }
    if (!matchedByImdb) {
      for (const s of todayAnimeCache) {
        const rec = offlineDB.byAniList.get(s.media.id);
        if (kitsuId && rec?.kitsu === kitsuId) { episode = s.episode; season = 1; console.log(`  📅 Today: kitsu:${kitsuId} → ep${episode}`); break; }
        if (anilistIdNum && s.media.id === anilistIdNum) { episode = s.episode; season = 1; console.log(`  📅 Today: anilist:${anilistIdNum} → ep${episode}`); break; }
      }
    }
  }

  // Handle at: ID format from Anime Today: at:187941:1:5
  if (fullId.startsWith('at:')) {
    const parts = fullId.split(':');
    const anilistId = parseInt(parts[1]);
    season = parseInt(parts[2]) || 1;
    episode = parseInt(parts[3]) || 1;
    console.log(`  🎌 AT: AniList ${anilistId} S${season}E${episode}`);
    const rec = offlineDB.byAniList.get(anilistId);

    if (rec?.anidb) {
      // Multi-season: try resolving via IMDb→TVDB→AniDB per-season
      if (season > 1 && rec.imdb) {
        const epResult = await resolveEpisode(type, rec.imdb, season, episode);
        if (epResult.anidbId) {
          console.log(`  🎯 Season-specific AniDB: ${epResult.anidbId} ep${epResult.episode}`);
          torrents = await searchByAniDBId(epResult.anidbId, epResult.episode, false, false);
        }
        // Also try absolute episode via Cinemeta offset
        if (!torrents.length && epResult.episode !== episode) {
          console.log(`  🔄 Trying absolute ep ${epResult.episode}`);
          torrents = await searchByAniDBId(rec.anidb, epResult.episode, false, false);
        }
      }
      // Season 1 or fallback
      if (!torrents.length) {
        console.log(`  🆔 AniList ${anilistId} → AniDB ${rec.anidb} "${rec.title}"`);
        torrents = await searchByAniDBId(rec.anidb, isMovie ? null : episode, isMovie, false);
      }
    }

    // Text search fallback for at: IDs
    if (!torrents.length) {
      const names = [];
      if (rec?.title) names.push(rec.title);
      const schedule = todayAnimeCache.find(s => s.media.id === anilistId);
      if (schedule?.media?.title) {
        const { romaji, english } = schedule.media.title;
        if (romaji && !names.includes(romaji)) names.push(romaji);
        if (english && !names.includes(english)) names.push(english);
      }
      if (names.length) {
        console.log(`  🔄 Fallback text search: [${names.join(', ')}]`);
        torrents = await searchByText(names, isMovie ? null : episode, isMovie);
      }
    }
  }
  // Handle TVDB ID format: tvdb:424536:2:8
  else if (fullId.startsWith('tvdb:')) {
    const parts = fullId.split(':');
    const tvdbId = parts[1];
    const tvdbSeason = parseInt(parts[2]) || 1;
    const tvdbEpisode = parseInt(parts[3]) || 1;
    season = tvdbSeason;
    episode = tvdbEpisode;
    console.log(`  📺 TVDB: ${tvdbId} S${tvdbSeason}E${tvdbEpisode}`);
    const resolved = resolveViaTVDB(tvdbId, tvdbSeason, tvdbEpisode);
    if (resolved?.anidbId) {
      torrents = await searchByAniDBId(resolved.anidbId, resolved.episode, isMovie, false);
    }
  }
  // Handle AniList ID format: anilist:154587:2:8 or anilist:154587
  else if (fullId.startsWith('anilist:')) {
    const parts = fullId.split(':');
    const anilistId = parseInt(parts[1]);
    season = parseInt(parts[2]) || 1;
    episode = parseInt(parts[3]) || 1;
    console.log(`  🔷 AniList: ${anilistId} S${season}E${episode}`);
    const rec = offlineDB.byAniList.get(anilistId);
    if (rec?.anidb) {
      if (season > 1) {
        // Try anime-lists for season-specific AniDB
        const tvdbId = getTVDBFromAniDB(rec.anidb);
        if (tvdbId) {
          const resolved = resolveViaTVDB(tvdbId, season, episode);
          if (resolved?.anidbId) {
            torrents = await searchByAniDBId(resolved.anidbId, resolved.episode, isMovie, false);
          }
        }
      }
      if (!torrents.length) {
        console.log(`  🆔 AniList ${anilistId} → AniDB ${rec.anidb} "${rec.title}"`);
        torrents = await searchByAniDBId(rec.anidb, isMovie ? null : episode, isMovie, false);
      }
    }
  }
  // Existing: IMDb (tt...) and Kitsu (kitsu:...)
  else {

  // 1. For multi-season: try anime-lists to get per-season AniDB ID + correct episode
  if (!torrents.length && season > 1 && !isMovie) {
    const epResult = await resolveEpisode(type, fullId, season, episode);
    if (epResult.anidbId) {
      // anime-lists gave us a season-specific AniDB ID
      console.log(`  🎯 Season-specific AniDB: ${epResult.anidbId} ep${epResult.episode}`);
      torrents = await searchByAniDBId(epResult.anidbId, epResult.episode, false, false);
    }
  }

  // 2. Base AniDB ID lookup (for S01, movies, or if season-specific failed)
  if (!torrents.length) {
    const resolved = await resolveToAniDB(type, fullId);
    if (resolved?.anidb) {
      const searchEp = isMovie ? null : episode;
      torrents = await searchByAniDBId(resolved.anidb, searchEp, isMovie, false);

      // If S01 episode search found nothing and season > 1, try absolute episode via Cinemeta offset
      if (!torrents.length && season > 1 && !isMovie) {
        const epResult = await resolveEpisode(type, fullId, season, episode);
        if (epResult.episode !== episode) {
          console.log(`  🔄 Trying absolute ep ${epResult.episode}`);
          torrents = await searchByAniDBId(resolved.anidb, epResult.episode, false, false);
        }
      }
    }
  }

  // 3. Fallback: text search
  if (!torrents.length) {
    let names = [];
    try {
      const resolved2 = await resolveToAniDB(type, fullId);
      if (resolved2?.title) names.push(resolved2.title);
    } catch {}

    if (fullId.startsWith('tt')) {
      try {
        const cine = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${fullId.split(':')[0]}.json`, { timeout: 5000 });
        const meta = cine.data?.meta;
        if (meta?.name) {
          const name = meta.name;
          if (!names.includes(name)) names.push(name);
          // Strip diacritics version
          const stripped = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (stripped !== name && !names.includes(stripped)) names.push(stripped);
        }
        // English aliases
        if (meta?.aliases) for (const a of meta.aliases) { if (!names.includes(a)) names.push(a); }
      } catch {}
    }

    if (names.length) {
      console.log(`  🔄 Fallback text search: [${names.join(', ')}]`);
      torrents = await searchByText(names, isMovie ? null : episode, isMovie);
    }
  }

  } // end else (IMDb/Kitsu)

  // Detect if this is a today's anime — skip cache and add RSS results
  let isTodayAnime = false;
  let todaySchedule = null;
  if (!isMovie) {
    // Check if IMDb ID matches any today anime
    for (const s of todayAnimeCache) {
      const rec = offlineDB.byAniList.get(s.media.id);
      if (rec?.imdb && fullId.startsWith(rec.imdb)) { isTodayAnime = true; todaySchedule = s; break; }
    }
    // Check AniList ID
    if (!isTodayAnime && fullId.startsWith('anilist:')) {
      const alId = parseInt(fullId.split(':')[1]);
      todaySchedule = todayAnimeCache.find(s => s.media.id === alId);
      if (todaySchedule) isTodayAnime = true;
    }
    // Check at: ID (Anime Today catalog)
    if (!isTodayAnime && fullId.startsWith('at:')) {
      const alId = parseInt(fullId.split(':')[1]);
      todaySchedule = todayAnimeCache.find(s => s.media.id === alId);
      if (todaySchedule) isTodayAnime = true;
    }
  }

  // For today's anime: add RSS results
  if (isTodayAnime && todaySchedule) {
    const rssNames = [todaySchedule.media.title.romaji, todaySchedule.media.title.english].filter(Boolean);
    const rssResults = searchRssIndex(rssNames, episode);
    if (rssResults.length) {
      const existingHashes = new Set(torrents.map(t => t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase()).filter(Boolean));
      const newRss = rssResults.filter(r => {
        const hash = r.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
        return hash && !existingHashes.has(hash);
      });
      if (newRss.length) {
        torrents = [...torrents, ...newRss];
        console.log(`  📡 +${newRss.length} from Nyaa RSS`);
      }
    }
  }

  if (!torrents.length) {
    return res.json({ streams: [{ name: '❌ Nenalezeno', title: `Nenalezeno na AnimeTosho`, url: 'https://animetosho.org', behaviorHints: { notWebReady: true } }] });
  }

  const hasRD = !!user?.rd_api_key;
  const hasTB = !!user?.tb_api_key;
  const tbTorrents = hasTB && user.tb_use_torrents;
  const tbNZB = hasTB && user.tb_use_nzb;
  // Use custom sort for today's anime, default sort otherwise
  const sorted = isTodayAnime ? sortByGroupPriority(torrents, user) : sortByGroupPriority(torrents);
  const withMagnet = sorted.filter(t => t.magnet).slice(0, 20);

  const streams = [];
  for (const t of withMagnet) {
    const name = t.name || '';
    const quality = detectQuality(name);
    const title = `${quality ? quality + ' · ' : ''}${name}\n👥 ${parseInt(t.seeders) || 0} seeders | 📦 ${t.filesize || '?'}`;
    const epNum = isMovie ? 0 : episode;

    if (hasRD) {
      streams.push({ name: `🎌 RD`, title,
        url: `${BASE_URL}/${token}/play/${storeMagnet(t.magnet)}/${epNum}/video.mp4`,
        behaviorHints: { bingeGroup: 'nyaa-rd', notWebReady: true } });
    }
    if (tbTorrents) {
      streams.push({ name: `📦 TB`, title,
        url: `${BASE_URL}/${token}/play-tb/${storeMagnet(t.magnet)}/${epNum}/video.mp4`,
        behaviorHints: { bingeGroup: 'nyaa-tb', notWebReady: true } });
    }
    if (tbNZB && t.nzb_url) {
      const nzbTitle = `${quality ? quality + ' · ' : ''}${name}\n📡 Usenet | 📦 ${t.filesize || '?'}`;
      streams.push({ name: `📡 NZB`, title: nzbTitle,
        url: `${BASE_URL}/${token}/play-nzb/${storeNZB(t.nzb_url, t.name)}/${epNum}/video.mp4`,
        behaviorHints: { bingeGroup: 'nyaa-nzb', notWebReady: true } });
    }
    if (!hasRD && !tbTorrents) {
      streams.push({ name: `🧲 AT`, title, url: t.magnet, behaviorHints: { notWebReady: true } });
    }
  }

  console.log(`  📤 Streams: ${streams.length}`);
  res.json({ streams });
});

// ===== Health =====
app.get('/health', (req, res) => {
  const rss = getRssStats();
  res.json({
    status: 'ok', uptime: process.uptime(),
    animeCount: todayAnimeCache.length,
    users: config.listUsers().length,
    offlineDB: offlineDB.loaded ? offlineDB.byAniDB.size : 0,
    rss: { indexed: rss.count, fetches: rss.fetches }
  });
});

// ===== Start =====
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server: ${BASE_URL}`);
  config.loadServerConfig();
  await config.restoreFromR2();

  // Load ID mapping databases
  await loadOfflineDB();
  await loadAnimeLists();
  await loadMappingCache();
  loadEidCache();

  const users = config.listUsers();
  console.log(`  TMDB: ${config.getTMDBKey() ? '✅' : '❌ (web)'}`);
  console.log(`  Users: ${users.length}`);
  updateCache().catch(err => console.error('❌ Initial cache:', err.message));
  startRssFetcher();
});

// Weekly update of anime-offline-database (Sundays at 5:00)
cron.schedule('0 5 * * 0', () => { weeklyUpdate().catch(e => console.error('Weekly update error:', e.message)); });
