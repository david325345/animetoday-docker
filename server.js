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
const { searchNekobt, validateApiKey: validateNekobtKey, sortNekobtResults } = require('./lib/nekobt');
const { searchByTVDB: nzbgeekSearch, searchByIMDb: nzbgeekMovieSearch, validateApiKey: validateNzbgeekKey } = require('./lib/nzbgeek');
const { searchByAniListId: seadexSearch, findEpisodeFile: seadexFindEpisode } = require('./lib/seadex');

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
    await generateAllPosters(schedules, offlineDB);

    // Pre-resolve IMDb IDs for all anime via TMDB (for catalog + Fusion compatibility)
    let resolved = 0;
    for (const s of schedules) {
      const offRec = offlineDB.byAniList.get(s.media.id);
      if (offRec?.imdb) {
        s.resolvedImdbId = offRec.imdb;
        resolved++;
      } else if (s.media.title) {
        const names = [s.media.title.romaji, s.media.title.english, s.media.title.native].filter(Boolean);
        if (names.length) {
          const imdbId = await resolveIMDbViaTMDB(names, s.media.id);
          if (imdbId) { s.resolvedImdbId = imdbId; resolved++; }
        }
      }
    }
    console.log(`🔗 IMDb resolved: ${resolved}/${schedules.length}`);

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
    has_nekobt: !!user.nekobt_api_key,
    nekobt_enabled: user.nekobt_enabled !== false,
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
    langPriority: user.langPriority || [],
    excludedResolutions: user.excludedResolutions || [],
    sortBySeeders: user.sortBySeeders !== false,
    defaultGroups: DEFAULT_GROUPS,
    defaultResolutions: DEFAULT_RESOLUTIONS,
    defaultLangs: []
  });
});

app.post('/api/sort-prefs/:token', express.json(), (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { customSortEnabled, groupPriority, resPriority, langPriority, excludedResolutions, sortBySeeders } = req.body;
  if (typeof customSortEnabled === 'boolean') user.customSortEnabled = customSortEnabled;
  if (Array.isArray(groupPriority)) user.groupPriority = groupPriority;
  if (Array.isArray(resPriority)) user.resPriority = resPriority;
  if (Array.isArray(langPriority)) user.langPriority = langPriority;
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

// ===== NekoBT API =====
app.post('/api/nekobt/save-key', express.json(), async (req, res) => {
  const { token, key } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!key) return res.json({ success: false, error: 'Missing API key' });

  const result = await validateNekobtKey(key);
  if (!result) return res.json({ success: false, error: 'Invalid NekoBT API key' });

  user.nekobt_api_key = key;
  user.nekobt_enabled = true;
  config.saveUser(token, user);
  console.log(`✅ NekoBT connected for ${token} (user: ${result.username})`);
  res.json({ success: true, username: result.username });
});

app.get('/api/nekobt/status/:token', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.nekobt_api_key) return res.json({ connected: false });

  const result = await validateNekobtKey(user.nekobt_api_key);
  if (!result) return res.json({ connected: false });

  res.json({
    connected: true,
    enabled: user.nekobt_enabled !== false,
    username: result.username,
  });
});

app.post('/api/nekobt/disconnect/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (user) {
    delete user.nekobt_api_key;
    delete user.nekobt_enabled;
    config.saveUser(req.params.token, user);
  }
  res.json({ success: true });
});

app.post('/api/nekobt/toggle', express.json(), (req, res) => {
  const { token, enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.nekobt_enabled = !!enabled;
  config.saveUser(token, user);
  res.json({ success: true });
});

// ===== NZBgeek API =====
app.post('/api/nzbgeek/save-key', express.json(), async (req, res) => {
  const { token, key } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!key) return res.json({ success: false, error: 'Missing API key' });

  const valid = await validateNzbgeekKey(key);
  if (!valid) return res.json({ success: false, error: 'Invalid NZBgeek API key' });

  user.nzbgeek_api_key = key;
  user.nzbgeek_enabled = true;
  config.saveUser(token, user);
  console.log(`✅ NZBgeek connected for ${token}`);
  res.json({ success: true });
});

app.get('/api/nzbgeek/status/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.nzbgeek_api_key) return res.json({ connected: false });
  res.json({
    connected: true,
    enabled: user.nzbgeek_enabled !== false,
  });
});

app.post('/api/nzbgeek/disconnect/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (user) {
    delete user.nzbgeek_api_key;
    delete user.nzbgeek_enabled;
    config.saveUser(req.params.token, user);
  }
  res.json({ success: true });
});

app.post('/api/nzbgeek/toggle', express.json(), (req, res) => {
  const { token, enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.nzbgeek_enabled = !!enabled;
  config.saveUser(token, user);
  res.json({ success: true });
});

// ===== SeaDex API =====
app.get('/api/seadex/status/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.json({ enabled: false });
  res.json({ enabled: user.seadex_enabled || false });
});

app.post('/api/seadex/toggle', express.json(), (req, res) => {
  const { token, enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.seadex_enabled = !!enabled;
  config.saveUser(token, user);
  res.json({ success: true });
});

// ===== My Indexer API =====
app.get('/api/indexer/status/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.json({ enabled: false });
  res.json({ enabled: user.indexer_enabled || false });
});

app.post('/api/indexer/toggle', express.json(), (req, res) => {
  const { token, enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.indexer_enabled = !!enabled;
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
      // Use IMDb ID for maximum compatibility (Fusion, Cinemeta), at: only as fallback
      const id = s.resolvedImdbId || `at:${m.id}`;
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

// TMDB → IMDb resolver: search by name, get external_ids
const tmdbImdbCache = new Map();

async function resolveIMDbViaTMDB(nameVariants, anilistId) {
  const cacheKey = `tmdb:${anilistId}`;
  if (tmdbImdbCache.has(cacheKey)) {
    const cached = tmdbImdbCache.get(cacheKey);
    if (cached) console.log(`  🔍 TMDB (cached): AniList ${anilistId} → ${cached}`);
    return cached;
  }

  const tmdbKey = config.getTMDBKey();
  if (!tmdbKey) { console.log(`  🔍 TMDB: no API key`); return null; }

  const offRec = offlineDB.byAniList.get(anilistId);

  // === Step 1: TVDB find (exact match, no search needed) ===
  const tvdbId = offRec?.tvdb;
  if (tvdbId) {
    try {
      const findResp = await axios.get(`https://api.themoviedb.org/3/find/${tvdbId}`, {
        params: { api_key: tmdbKey, external_source: 'tvdb_id' },
        timeout: 5000
      });
      const tvResults = findResp.data?.tv_results;
      if (tvResults?.length) {
        const tmdbId = tvResults[0].id;
        try {
          const extResp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, {
            params: { api_key: tmdbKey },
            timeout: 5000
          });
          const imdbId = extResp.data?.imdb_id;
          if (imdbId && imdbId.startsWith('tt')) {
            console.log(`  🔍 TMDB: TVDB ${tvdbId} → TMDB ${tmdbId} "${tvResults[0].name}" → ${imdbId}`);
            tmdbImdbCache.set(cacheKey, imdbId);
            if (offRec && !offRec.imdb) offRec.imdb = imdbId;
            return imdbId;
          }
        } catch {}
      }
      console.log(`  🔍 TMDB: TVDB ${tvdbId} → no IMDb found`);
    } catch (err) {
      console.log(`  🔍 TMDB find by TVDB error: ${err.message}`);
    }
  }

  // === Step 2: Name search with cleaned variants ===
  // Always clean names first — never search with "Season 3", "Part 2", etc.
  function cleanAnimeName(name) {
    if (!name) return '';
    return name
      .replace(/\s*(\d+(?:st|nd|rd|th))?\s*(Season|Part|Cour|Series|Phase|Chapter|Arc)\s*\d*\s*$/i, '') // "X Season 3" → "X"
      .replace(/\s+\d+$/, '') // trailing number: "Shingeki no Kyojin 3" → "Shingeki no Kyojin"
      .replace(/\s+[IVXLC]+$/, '') // roman numerals: "Title III" → "Title"
      .replace(/[!?♪♫★☆~※♥❤.,;'"`(){}[\]]/g, '') // strip special chars: "Title!" → "Title"
      .replace(/\s{2,}/g, ' ') // collapse double spaces
      .trim();
  }

  const searchNames = [];
  for (const name of nameVariants) {
    if (!name) continue;
    const clean = cleanAnimeName(name);
    if (clean && clean.length >= 3 && !searchNames.includes(clean)) searchNames.push(clean);

    // Also try without subtitle after colon/dash
    const noSubtitle = clean.split(/[:\-–—]/)[0].trim();
    if (noSubtitle && noSubtitle !== clean && noSubtitle.length >= 3 && !searchNames.includes(noSubtitle)) {
      searchNames.push(noSubtitle);
    }
  }

  for (const searchName of searchNames) {
    try {
      const searchResp = await axios.get('https://api.themoviedb.org/3/search/tv', {
        params: { api_key: tmdbKey, query: searchName, language: 'en-US' },
        timeout: 5000
      });
      const results = searchResp.data?.results;
      if (!results?.length) {
        console.log(`  🔍 TMDB: no results for "${searchName}"`);
        continue;
      }

      // Prefer animation genre (16)
      const sorted = [...results].sort((a, b) => {
        const aAnim = (a.genre_ids || []).includes(16) ? 1 : 0;
        const bAnim = (b.genre_ids || []).includes(16) ? 1 : 0;
        return bAnim - aAnim || (b.popularity || 0) - (a.popularity || 0);
      });

      for (const result of sorted.slice(0, 3)) {
        try {
          const extResp = await axios.get(`https://api.themoviedb.org/3/tv/${result.id}/external_ids`, {
            params: { api_key: tmdbKey },
            timeout: 5000
          });
          const imdbId = extResp.data?.imdb_id;
          if (imdbId && imdbId.startsWith('tt')) {
            console.log(`  🔍 TMDB: "${searchName}" → TMDB ${result.id} "${result.name}" → ${imdbId}`);
            tmdbImdbCache.set(cacheKey, imdbId);
            if (offRec && !offRec.imdb) offRec.imdb = imdbId;
            return imdbId;
          }
        } catch {}
      }
      console.log(`  🔍 TMDB: "${searchName}" found ${results.length} results but no IMDb ID`);
    } catch (err) {
      console.log(`  🔍 TMDB search error for "${searchName}": ${err.message}`);
    }
  }

  console.log(`  🔍 TMDB: all variants failed for AniList ${anilistId}`);
  tmdbImdbCache.set(cacheKey, null);
  return null;
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
  let imdbId = offRec?.imdb;

  console.log(`  🔍 AniList: ${anilistId}, IMDb: ${imdbId || 'none'}, schedule: ${schedule ? 'yes' : 'no'}`);

  // If no IMDb, try TMDB search with multiple name variants
  if (!imdbId && m?.title) {
    const names = [m.title.romaji, m.title.english, m.title.native].filter(Boolean);
    if (names.length) {
      imdbId = await resolveIMDbViaTMDB(names, anilistId);
    }
  }

  // === Strategy 1: IMDb exists → full Cinemeta proxy, only swap id ===
  if (imdbId) {
    const cinemeta = await getCinemetaMeta(imdbId);
    if (cinemeta) {
      const meta = { ...cinemeta, id: atId };
      console.log(`  📤 Meta (Cinemeta proxy): ${meta.name} — ${(meta.videos || []).length} videos`);
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
    id: 'cz.nyaa.search.v7',
    version: '7.0.0',
    name: 'Nyaa Search',
    description: 'Anime z Nyaa.si + RealDebrid. Funguje s Cinemeta/Kitsu/Anime Today.',
    logo: `${BASE_URL}/logo-nyaa.png`,
    resources: ['stream', 'meta'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['at:', 'kitsu:', 'tt', 'tvdb:', 'anilist:'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

app.get('/:token/nyaa/meta/:type/:id.json', async (req, res) => {
  const fullId = req.params.id;
  const type = req.params.type;
  console.log(`=== NYAA META === type=${type} id=${fullId}`);

  // === IMDb (tt...) — Cinemeta proxy ===
  if (fullId.startsWith('tt')) {
    const imdbId = fullId.split(':')[0];
    const cinemeta = await getCinemetaMeta(imdbId);
    if (cinemeta) {
      const meta = { ...cinemeta, id: fullId };
      console.log(`  📤 IMDb Meta (Cinemeta proxy): ${meta.name} — ${(meta.videos || []).length} videos`);
      return res.json({ meta });
    }
    console.log(`  ⚠️ Cinemeta no data for ${imdbId}`);
    return res.json({ meta: null });
  }

  // === at: (Anime Today) — resolve to IMDb via TMDB, then Cinemeta proxy ===
  if (fullId.startsWith('at:')) {
    const anilistId = parseInt(fullId.split(':')[1]);
    if (!anilistId) return res.json({ meta: null });

    const schedule = todayAnimeCache.find(s => s.media.id === anilistId);
    const m = schedule?.media;
    const offRec = offlineDB.byAniList.get(anilistId);
    let imdbId = offRec?.imdb;

    console.log(`  🔍 AT: AniList ${anilistId}, IMDb: ${imdbId || 'none'}`);

    if (!imdbId && m?.title) {
      const names = [m.title.romaji, m.title.english, m.title.native].filter(Boolean);
      if (names.length) imdbId = await resolveIMDbViaTMDB(names, anilistId);
    }

    if (imdbId) {
      const cinemeta = await getCinemetaMeta(imdbId);
      if (cinemeta) {
        const meta = { ...cinemeta, id: fullId };
        console.log(`  📤 AT Meta (Cinemeta proxy): ${meta.name} — ${(meta.videos || []).length} videos`);
        return res.json({ meta });
      }
    }

    // Fallback: generate episodes
    const currentEp = schedule?.episode || offRec?.episodes || 1;
    const totalEp = m?.episodes || currentEp;
    const epCount = Math.max(currentEp, totalEp);
    const videos = [];
    for (let ep = 1; ep <= epCount; ep++) {
      videos.push({ id: `at:${anilistId}:1:${ep}`, title: `Episode ${ep}`, season: 1, episode: ep });
    }
    const meta = {
      id: fullId, type: 'series',
      name: m?.title?.romaji || m?.title?.english || offRec?.title || 'Unknown',
      description: m?.description ? m.description.replace(/<[^>]*>/g, '') : '',
      genres: m?.genres || [],
      videos,
    };
    console.log(`  📤 AT Meta (fallback): ${meta.name} — ${videos.length} videos`);
    return res.json({ meta });
  }

  // === Kitsu ===
  if (!fullId.startsWith('kitsu:')) return res.json({ meta: null });

  const kitsuId = parseInt(fullId.split(':')[1]);
  if (!kitsuId) return res.json({ meta: null });

  const offRec = offlineDB.byKitsu.get(kitsuId);
  let imdbId = offRec?.imdb;

  console.log(`  🔍 Kitsu: ${kitsuId}, AniDB: ${offRec?.anidb || 'none'}, IMDb: ${imdbId || 'none'}`);

  // If no IMDb, try TMDB
  if (!imdbId && offRec) {
    const names = [offRec.title, ...(offRec.synonyms || []).slice(0, 3)].filter(Boolean);
    if (names.length) {
      // Use anilist ID for cache key if available, otherwise kitsu
      const cacheId = offRec.anilist || kitsuId;
      imdbId = await resolveIMDbViaTMDB(names, cacheId);
      if (imdbId && !offRec.imdb) offRec.imdb = imdbId;
    }
  }

  // Cinemeta proxy
  if (imdbId) {
    const cinemeta = await getCinemetaMeta(imdbId);
    if (cinemeta) {
      const meta = { ...cinemeta, id: fullId };
      console.log(`  📤 Kitsu Meta (Cinemeta proxy): ${meta.name} — ${(meta.videos || []).length} videos`);
      return res.json({ meta });
    }
    console.log(`  ⚠️ Cinemeta fetch failed for ${imdbId}`);
  }

  // Fallback: generate episodes
  const epCount = offRec?.episodes || 1;
  console.log(`  📺 Kitsu fallback: generating ${epCount} episodes`);

  const videos = [];
  for (let ep = 1; ep <= epCount; ep++) {
    videos.push({
      id: `kitsu:${kitsuId}:1:${ep}`,
      title: `Episode ${ep}`,
      season: 1,
      episode: ep,
    });
  }

  const meta = {
    id: fullId,
    type: 'series',
    name: offRec?.title || 'Unknown',
    description: '',
    videos,
  };

  console.log(`  📤 Kitsu Meta (fallback): ${meta.name} — ${videos.length} videos`);
  res.json({ meta });
});

app.get('/:token/nyaa/stream/:type/:id.json', async (req, res) => {
  const token = req.params.token;
  const type = req.params.type;
  const fullId = req.params.id;
  const user = config.getUser(token);
  const isMovie = type === 'movie';

  console.log(`=== STREAM === type=${type} id=${fullId}`);

  let { season, episode } = parseEpisodeAndSeason(fullId);

  // Detect if episode was explicitly provided in the ID
  const idParts = fullId.split(':');
  const hasExplicitEpisode = fullId.startsWith('at:') ? idParts.length >= 3 :
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

  // ===== UNIFIED ID RESOLVE (before any search) =====
  const resolved = { anidbId: null, anilistId: null, tvdbId: null, names: [], title: null };

  if (fullId.startsWith('at:')) {
    const alId = parseInt(fullId.split(':')[1]);
    resolved.anilistId = alId;
    const rec = offlineDB.byAniList.get(alId);
    if (rec) {
      resolved.anidbId = rec.anidb || null;
      resolved.tvdbId = rec.tvdb || null;
      resolved.title = rec.title || null;
      if (rec.title) resolved.names.push(rec.title);
    }
    const sched = todayAnimeCache.find(s => s.media.id === alId);
    if (sched?.media?.title) {
      const { romaji, english } = sched.media.title;
      if (romaji && !resolved.names.includes(romaji)) resolved.names.push(romaji);
      if (english && !resolved.names.includes(english)) resolved.names.push(english);
    }
  } else if (fullId.startsWith('anilist:')) {
    const alId = parseInt(fullId.split(':')[1]);
    resolved.anilistId = alId;
    const rec = offlineDB.byAniList.get(alId);
    if (rec) {
      resolved.anidbId = rec.anidb || null;
      resolved.tvdbId = rec.tvdb || null;
      resolved.title = rec.title || null;
      if (rec.title) resolved.names.push(rec.title);
    }
  } else if (fullId.startsWith('kitsu:')) {
    const kitsuId = parseInt(fullId.split(':')[1]);
    const rec = offlineDB.byKitsu.get(kitsuId);
    if (rec) {
      resolved.anidbId = rec.anidb || null;
      resolved.anilistId = rec.anilist || null;
      resolved.tvdbId = rec.tvdb || null;
      resolved.title = rec.title || null;
      if (rec.title) resolved.names.push(rec.title);
    }
  } else if (fullId.startsWith('tvdb:')) {
    const tvdbId = fullId.split(':')[1];
    resolved.tvdbId = tvdbId;
    const tvdbResolved = resolveViaTVDB(tvdbId, season, episode);
    if (tvdbResolved?.anidbId) {
      resolved.anidbId = tvdbResolved.anidbId;
      const rec = offlineDB.byAniDB.get(tvdbResolved.anidbId);
      if (rec) {
        resolved.anilistId = rec.anilist || null;
        resolved.title = rec.title || null;
        if (rec.title) resolved.names.push(rec.title);
      }
    }
  } else if (fullId.startsWith('tt')) {
    // IMDb — try offline-db scan + anime-lists
    const imdbBase = fullId.split(':')[0];
    for (const [alId, rec] of offlineDB.byAniList) {
      if (rec.imdb === imdbBase) {
        resolved.anilistId = alId;
        resolved.anidbId = rec.anidb || null;
        resolved.tvdbId = rec.tvdb || null;
        resolved.title = rec.title || null;
        if (rec.title) resolved.names.push(rec.title);
        break;
      }
    }
    // Fallback: todayAnimeCache
    if (!resolved.anilistId) {
      for (const s of todayAnimeCache) {
        const rec = offlineDB.byAniList.get(s.media.id);
        if (rec?.imdb === imdbBase || s.resolvedImdbId === imdbBase) {
          resolved.anilistId = s.media.id;
          resolved.anidbId = rec?.anidb || null;
          resolved.tvdbId = rec?.tvdb || null;
          resolved.title = rec?.title || null;
          if (rec?.title && !resolved.names.includes(rec.title)) resolved.names.push(rec.title);
          if (s.media?.title?.romaji && !resolved.names.includes(s.media.title.romaji)) resolved.names.push(s.media.title.romaji);
          if (s.media?.title?.english && !resolved.names.includes(s.media.title.english)) resolved.names.push(s.media.title.english);
          break;
        }
      }
    }
  }

  console.log(`  🔗 Resolved: AniDB=${resolved.anidbId || '?'}, AniList=${resolved.anilistId || '?'}, TVDB=${resolved.tvdbId || '?'}, names=[${resolved.names.join(', ')}]`);

  // Detect today's anime early (needed for RSS)
  let isTodayAnime = false;
  let todaySchedule = null;
  if (!isMovie) {
    for (const s of todayAnimeCache) {
      const rec = offlineDB.byAniList.get(s.media.id);
      if (resolved.anilistId && s.media.id === resolved.anilistId) { isTodayAnime = true; todaySchedule = s; break; }
      if (rec?.imdb && fullId.startsWith(rec.imdb)) { isTodayAnime = true; todaySchedule = s; break; }
    }
    // Add today schedule names to resolved
    if (todaySchedule?.media?.title) {
      const { romaji, english } = todaySchedule.media.title;
      if (romaji && !resolved.names.includes(romaji)) resolved.names.push(romaji);
      if (english && !resolved.names.includes(english)) resolved.names.push(english);
    }
  }

  // ===== PARALLEL SEARCH: AnimeTosho + NekoBT + SeaDex + My Indexer =====
  const hasNekobt = user?.nekobt_api_key && user?.nekobt_enabled !== false;
  const hasSeadex = user?.seadex_enabled;
  const hasIndexer = user?.indexer_enabled;

  // AnimeTosho search task (complex flow with fallbacks)
  const atSearchTask = (async () => {
    let torrents = [];
    // Handle at: ID format from Anime Today: at:187941:1:5 or at:187941:5
  if (fullId.startsWith('at:')) {
    const parts = fullId.split(':');
    const anilistId = parseInt(parts[1]);
    if (parts.length >= 4) {
      season = parseInt(parts[2]) || 1;
      episode = parseInt(parts[3]) || 1;
    } else {
      season = 1;
      episode = parseInt(parts[2]) || 1;
    }
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

    // Add RSS for today's anime
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

    return torrents;
  })().catch(err => { console.error(`  AT search error: ${err.message}`); return []; });

  // NekoBT search task
  const nekobtTask = (hasNekobt && resolved.names.length) ?
    (async () => {
      console.log(`  🐱 NekoBT search: [${resolved.names.join(', ')}] S${season}E${episode}`);
      return await searchNekobt(resolved.names, user.nekobt_api_key, season, episode, isMovie);
    })().catch(() => []) :
    // Fallback: need async name resolve
    (hasNekobt ?
      (async () => {
        const names = [...resolved.names];
        if (!names.length) {
          try {
            const res = await resolveToAniDB(type, fullId);
            if (res?.title) names.push(res.title);
          } catch {}
        }
        if (!names.length && fullId.startsWith('tt')) {
          try {
            const cine = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${fullId.split(':')[0]}.json`, { timeout: 5000 });
            if (cine.data?.meta?.name) names.push(cine.data.meta.name);
          } catch {}
        }
        if (names.length) {
          console.log(`  🐱 NekoBT search: [${names.join(', ')}] S${season}E${episode}`);
          return await searchNekobt(names, user.nekobt_api_key, season, episode, isMovie);
        }
        return [];
      })().catch(() => []) :
      Promise.resolve([])
    );

  // SeaDex search task
  const seadexTask = hasSeadex ?
    (async () => {
      let alId = resolved.anilistId;
      // Async fallback if no AniList ID yet
      if (!alId && fullId.startsWith('tt')) {
        try {
          const res = await resolveToAniDB('series', fullId.split(':')[0]);
          if (res?.anidb) {
            const rec = offlineDB.byAniDB.get(res.anidb);
            if (rec?.anilist) alId = rec.anilist;
          }
        } catch {}
      }
      if (alId) {
        console.log(`  🏆 SeaDex: searching AniList ${alId}`);
        return await seadexSearch(alId);
      }
      console.log(`  🏆 SeaDex: no AniList ID resolved`);
      return [];
    })().catch(() => []) :
    Promise.resolve([]);

  // My Indexer task (NimeToDex)
  const indexerTask = hasIndexer ?
    (async () => {
      const t0 = Date.now();
      const params = new URLSearchParams();

      // Send all IDs we already have — API has its own fallback chain
      if (fullId.startsWith('tt')) params.set('imdb', fullId.split(':')[0]);
      if (resolved.anilistId) params.set('anilist', resolved.anilistId);
      if (resolved.tvdbId) params.set('tvdb', resolved.tvdbId);
      if (resolved.anidbId) params.set('anidb', resolved.anidbId);
      if (season && !isMovie) params.set('season', season);
      if (episode && !isMovie) params.set('episode', episode);

      if (!params.toString()) return [];

      try {
        console.log(`  📦 Indexer: searching ${params.toString()}`);
        const resp = await axios.get(`https://nimetodex.duckdns.org/search?${params.toString()}`, { timeout: 8000 });
        const results = resp.data?.results || [];
        const ms = Date.now() - t0;
        console.log(`  📦 Indexer: ${results.length} results (${ms}ms, searchedBy: ${resp.data?.searchedBy || '?'})`);

        return results
          .filter(r => r.magnet || r.infohash)
          .map(r => ({
            name: r.name || 'Unknown',
            magnet: r.magnet || (r.infohash ? `magnet:?xt=urn:btih:${r.infohash}` : null),
            infohash: r.infohash || null,
            seeders: String(r.seeders || 0),
            leechers: String(r.leechers || 0),
            filesize: r.filesize ? formatIndexerFilesize(r.filesize) : '?',
            source: 'indexer',
            indexer: true,
            releaseGroup: r.group_name || '',
            resolution: r.resolution || '',
            dualAudio: !!r.dual_audio,
            seadexBest: !!r.seadex_best,
            batch: !!r.batch,
            videoSource: r.video_source || '',
            codec: r.codec || '',
          }));
      } catch (err) {
        const ms = Date.now() - t0;
        console.log(`  📦 Indexer error (${ms}ms): ${err.message}`);
        return [];
      }
    })().catch(() => []) :
    Promise.resolve([]);

  // ===== Run all four in parallel =====
  const [atResults, nekobtResults, seadexResults, indexerResults] = await Promise.all([atSearchTask, nekobtTask, seadexTask, indexerTask]);

  let torrents = atResults;

  // Merge NekoBT results
  if (nekobtResults.length) {
    const existingHashes = new Set(
      torrents.map(t => {
        const h = t.infohash || t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1];
        return h?.toLowerCase();
      }).filter(Boolean)
    );
    const newNekobt = nekobtResults.filter(t => {
      const h = t.infohash?.toLowerCase();
      return h && !existingHashes.has(h);
    });
    if (newNekobt.length) {
      const sortedNeko = sortNekobtResults(newNekobt);
      torrents = [...torrents, ...sortedNeko];
      console.log(`  🐱 +${newNekobt.length} unique from NekoBT (${nekobtResults.length - newNekobt.length} duplicates)`);
    } else {
      console.log(`  🐱 NekoBT: all ${nekobtResults.length} results already present`);
    }
  }

  // Merge SeaDex results — mark existing + add new
  if (seadexResults.length) {
    const seadexByHash = new Map();
    for (const sr of seadexResults) {
      if (sr.infohash) seadexByHash.set(sr.infohash.toLowerCase(), sr);
    }
    let marked = 0;
    for (const t of torrents) {
      const h = (t.infohash || t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1] || '').toLowerCase();
      const sr = h ? seadexByHash.get(h) : null;
      if (sr) {
        t.seadex = true;
        t.isBest = sr.isBest;
        t.dualAudio = sr.dualAudio;
        seadexByHash.delete(h);
        marked++;
      }
    }
    const remaining = [...seadexByHash.values()];
    if (remaining.length) torrents = [...torrents, ...remaining];
    console.log(`  🏆 SeaDex: ${marked} marked, +${remaining.length} new (${seadexResults.length} total)`);
  }

  // Merge Indexer results (always at the bottom, no dedup)
  // Don't add indexer to main torrents — keep separate for display at bottom
  if (!torrents.length && !indexerResults.length) {
    return res.json({ streams: [{ name: '❌ Nenalezeno', title: `Nenalezeno na AnimeTosho`, url: 'https://animetosho.org', behaviorHints: { notWebReady: true } }] });
  }

  const hasRD = !!user?.rd_api_key;
  const hasTB = !!user?.tb_api_key;
  const tbTorrents = hasTB && user.tb_use_torrents;
  // Sort and limit main results (AT + NekoBT + SeaDex)
  const sorted = sortByGroupPriority(torrents, user || null);
  const maxResults = hasNekobt ? 30 : 20;
  const withMagnet = sorted.filter(t => t.magnet).slice(0, maxResults);

  // Append ALL indexer results at the end (no limit, no sort)
  const allResults = [...withMagnet, ...indexerResults.filter(t => t.magnet)];

  const streams = [];
  for (const t of allResults) {
    const name = t.name || '';
    const quality = detectQuality(name);
    const epNum = isMovie ? 0 : episode;

    // Unified format: "🏆 SeaDex · 1080p · [Group]\nTorrent Name\n👥 seeders | 📦 size"
    const tags = [];
    if (t.seadex) tags.push('🏆 SeaDex');
    if (t.indexer) tags.push('📦 Indexer');
    if (quality) tags.push(quality);
    if (t.nekobt && t.groups?.length) tags.push(`[${t.groups[0]}]`);
    if (t.nekobt && t.level >= 3) tags.push('⭐OTL');
    else if (t.nekobt && t.mtl) tags.push('⚠️MTL');
    if ((t.seadex && t.dualAudio) || (t.indexer && t.dualAudio)) tags.push('Dual Audio');
    const line1 = tags.filter(Boolean).join(' · ');
    const statsLine = t.seadex
      ? `📦 ${t.filesize || '?'}`
      : `👥 ${parseInt(t.seeders) || 0} seeders | 📦 ${t.filesize || '?'}`;
    const title = `${line1 ? line1 + '\n' : ''}${name}\n${statsLine}`;

    // Stream name label
    const streamName = t.seadex ? '🏆' :
                       t.indexer ? '📦' :
                       t.nekobt ? '🐱' : '🎌';

    if (hasRD) {
      streams.push({ name: `${streamName} RD`, title,
        url: `${BASE_URL}/${token}/play/${storeMagnet(t.magnet)}/${epNum}/video.mp4`,
        behaviorHints: { bingeGroup: t.seadex ? 'seadex-rd' : t.indexer ? 'indexer-rd' : t.nekobt ? 'neko-rd' : 'nyaa-rd', notWebReady: true } });
    }
    if (tbTorrents) {
      streams.push({ name: `${streamName} TB`, title,
        url: `${BASE_URL}/${token}/play-tb/${storeMagnet(t.magnet)}/${epNum}/video.mp4`,
        behaviorHints: { bingeGroup: t.seadex ? 'seadex-tb' : t.indexer ? 'indexer-tb' : t.nekobt ? 'neko-tb' : 'nyaa-tb', notWebReady: true } });
    }
    if (!hasRD && !tbTorrents) {
      streams.push({ name: streamName, title, url: t.magnet, behaviorHints: { notWebReady: true } });
    }
  }

  if (indexerResults.length) console.log(`  📦 +${indexerResults.length} from Indexer (appended at bottom)`);
  console.log(`  📤 Streams: ${streams.length}${hasNekobt ? ' (NekoBT enabled)' : ''}${hasIndexer ? ' (Indexer enabled)' : ''}`);
  res.json({ streams });
});

// ===== STREMIO: NYAA NZB SEARCH ADDON =====
app.get('/:token/nzb/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nzb.search.v1',
    version: '1.0.0',
    name: 'NZB Search',
    description: 'NZB z NZBgeek + AnimeTosho — Usenet streaming přes TorBox. Anime, seriály, filmy.',
    logo: `${BASE_URL}/logo-nzb.png`,
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['at:', 'kitsu:', 'tt', 'tvdb:', 'anilist:'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// ===== Language score helper for NZB sorting =====
// Returns lowest index from langOrder found in item's language/subs/title
// Lower = better match. Items with no match get langOrder.length (worst)
// ===== Format filesize from indexer (bytes → human readable) =====
function formatIndexerFilesize(bytes) {
  if (!bytes) return '?';
  const n = parseInt(bytes);
  if (isNaN(n)) return '?';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

function getLangScore(item, langOrder) {
  // Combine all language info: NZBgeek attrs + title keywords
  const langText = [
    item.language || '',
    item.subs || '',
    item.name || ''
  ].join(' ').toLowerCase();

  // Common language aliases
  const aliases = {
    'cz': ['czech', 'cze', 'ces', 'cz'],
    'en': ['english', 'eng', 'en'],
    'de': ['german', 'deu', 'ger', 'de'],
    'fr': ['french', 'fre', 'fra', 'fr'],
    'es': ['spanish', 'spa', 'es'],
    'it': ['italian', 'ita', 'it'],
    'pt': ['portuguese', 'por', 'pt'],
    'ja': ['japanese', 'jpn', 'ja'],
    'ko': ['korean', 'kor', 'ko'],
    'zh': ['chinese', 'zho', 'chi', 'zh'],
    'ru': ['russian', 'rus', 'ru'],
    'pl': ['polish', 'pol', 'pl'],
    'nl': ['dutch', 'nld', 'dut', 'nl'],
    'sk': ['slovak', 'slk', 'slo', 'sk'],
    'hu': ['hungarian', 'hun', 'hu'],
    'multi': ['multi'],
  };

  for (let i = 0; i < langOrder.length; i++) {
    const lang = langOrder[i].toLowerCase();
    // Direct match
    if (langText.includes(lang)) return i;
    // Alias match
    const aliasList = aliases[lang] || [];
    for (const alias of aliasList) {
      if (langText.includes(alias)) return i;
    }
    // Also check if any alias key matches this lang
    for (const [key, vals] of Object.entries(aliases)) {
      if (vals.includes(lang) && (langText.includes(key) || vals.some(v => langText.includes(v)))) return i;
    }
  }
  return langOrder.length; // no match
}

// ===== Filter language string to show only user-preferred languages =====
// "French - Japanese - English - Russian" + userLangs=['en','jp'] → "English - Japanese"
function filterLangString(langStr, userLangs) {
  if (!langStr || !userLangs?.length) return langStr; // no filter, show all

  const aliases = {
    'cz': ['czech', 'cze', 'ces', 'cz'],
    'en': ['english', 'eng', 'en'],
    'de': ['german', 'deu', 'ger', 'de'],
    'fr': ['french', 'fre', 'fra', 'fr'],
    'es': ['spanish', 'spa', 'es'],
    'it': ['italian', 'ita', 'it'],
    'pt': ['portuguese', 'por', 'pt'],
    'ja': ['japanese', 'jpn', 'ja', 'jp'],
    'ko': ['korean', 'kor', 'ko'],
    'zh': ['chinese', 'zho', 'chi', 'zh'],
    'ru': ['russian', 'rus', 'ru'],
    'pl': ['polish', 'pol', 'pl'],
    'nl': ['dutch', 'nld', 'dut', 'nl'],
    'sk': ['slovak', 'slk', 'slo', 'sk'],
    'hu': ['hungarian', 'hun', 'hu'],
    'multi': ['multi'],
  };

  // Build set of all alias words the user wants
  const wantedWords = new Set();
  for (const lang of userLangs) {
    wantedWords.add(lang);
    const al = aliases[lang] || [];
    for (const a of al) wantedWords.add(a);
    // Reverse: if user typed "japanese", also match "ja"
    for (const [key, vals] of Object.entries(aliases)) {
      if (vals.includes(lang)) { wantedWords.add(key); for (const v of vals) wantedWords.add(v); }
    }
  }

  // Split language string by common separators and keep only matching parts
  const parts = langStr.split(/\s*[-,/]\s*/);
  const kept = parts.filter(p => wantedWords.has(p.toLowerCase().trim()));

  return kept.length ? kept.join(' - ') : '';
}

app.get('/:token/nzb/stream/:type/:id.json', async (req, res) => {
  const token = req.params.token;
  const type = req.params.type;
  const fullId = req.params.id;
  const user = config.getUser(token);
  const isMovie = type === 'movie';

  // NZB addon requires TorBox with NZB enabled
  if (!user?.tb_api_key || !user?.tb_use_nzb) {
    return res.json({ streams: [] });
  }

  console.log(`=== NZB STREAM === type=${type} id=${fullId}`);

  let { season, episode } = parseEpisodeAndSeason(fullId);
  const idParts = fullId.split(':');

  // Detect if episode was explicitly provided
  const hasExplicitEpisode = fullId.startsWith('at:') ? idParts.length >= 3 :
    fullId.startsWith('kitsu:') ? idParts.length >= 4 :
    fullId.startsWith('tt') ? idParts.length >= 3 :
    fullId.startsWith('anilist:') ? idParts.length >= 4 :
    fullId.startsWith('tvdb:') ? idParts.length >= 4 : idParts.length >= 3;

  // If no explicit episode, check todayAnimeCache
  if (!hasExplicitEpisode && !isMovie) {
    const imdbBase = fullId.startsWith('tt') ? idParts[0] : null;
    if (imdbBase) {
      for (const s of todayAnimeCache) {
        const rec = offlineDB.byAniList.get(s.media.id);
        if (rec?.imdb === imdbBase) { episode = s.episode; season = 1; break; }
      }
    }
    if (fullId.startsWith('at:')) {
      const alId = parseInt(idParts[1]);
      const sched = todayAnimeCache.find(s => s.media.id === alId);
      if (sched) { episode = sched.episode; season = 1; }
    }
  }

  // Parse at: IDs
  if (fullId.startsWith('at:')) {
    const parts = fullId.split(':');
    if (parts.length >= 4) { season = parseInt(parts[2]) || 1; episode = parseInt(parts[3]) || 1; }
    else { season = 1; episode = parseInt(parts[2]) || 1; }
  }

  // ===== Resolve TVDB ID =====
  let tvdbId = null;
  let animeName = null;

  // From at: ID → AniList → offline-db → TVDB
  if (fullId.startsWith('at:')) {
    const anilistId = parseInt(idParts[1]);
    const rec = offlineDB.byAniList.get(anilistId);
    if (rec?.tvdb) tvdbId = rec.tvdb;
    const sched = todayAnimeCache.find(s => s.media.id === anilistId);
    animeName = sched?.media?.title?.romaji || rec?.title;
  }
  // From tvdb: ID
  else if (fullId.startsWith('tvdb:')) {
    tvdbId = idParts[1];
  }
  // From anilist: ID
  else if (fullId.startsWith('anilist:')) {
    const anilistId = parseInt(idParts[1]);
    season = parseInt(idParts[2]) || 1;
    episode = parseInt(idParts[3]) || 1;
    const rec = offlineDB.byAniList.get(anilistId);
    if (rec?.tvdb) tvdbId = rec.tvdb;
    animeName = rec?.title;
  }
  // From tt (IMDb) → resolve via anime-lists
  else if (fullId.startsWith('tt')) {
    const imdbId = idParts[0];
    try {
      const resolved = await resolveToAniDB(type, imdbId);
      if (resolved?.tvdbId) tvdbId = resolved.tvdbId;
      animeName = resolved?.title;
      // Also try Cinemeta for TVDB
      if (!tvdbId) {
        const cine = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
        tvdbId = cine.data?.meta?.tvdb_id;
        if (!animeName) animeName = cine.data?.meta?.name;
      }
    } catch {}
  }
  // From kitsu: → resolve
  else if (fullId.startsWith('kitsu:')) {
    const kitsuId = parseInt(idParts[1]);
    const rec = offlineDB.byKitsu.get(kitsuId);
    if (rec?.tvdb) tvdbId = rec.tvdb;
    animeName = rec?.title;
  }

  console.log(`  📰 NZB: TVDB=${tvdbId || 'none'}, S${season}E${episode}, name="${animeName || '?'}"`);

  let nzbResults = [];

  // ===== Source 1: AnimeTosho NZB (from existing torrent search) =====
  // Reuse existing search logic to find AnimeTosho results with nzb_url
  let atNzbResults = [];
  if (fullId.startsWith('at:') || fullId.startsWith('tt') || fullId.startsWith('kitsu:') || fullId.startsWith('anilist:') || fullId.startsWith('tvdb:')) {
    // Quick AniDB-based search for AnimeTosho NZBs
    let anidbId = null;
    if (fullId.startsWith('at:')) {
      const rec = offlineDB.byAniList.get(parseInt(idParts[1]));
      anidbId = rec?.anidb;
    } else {
      try {
        const resolved = await resolveToAniDB(type, fullId);
        anidbId = resolved?.anidb;
      } catch {}
    }
    if (anidbId) {
      const { searchByAniDBId } = require('./lib/search');
      const torrents = await searchByAniDBId(anidbId, isMovie ? null : episode, isMovie, false);
      atNzbResults = torrents.filter(t => t.nzb_url).map(t => ({
        name: t.name,
        nzb_url: t.nzb_url,
        filesize: t.filesize,
        seeders: t.seeders,
        source: 'animetosho',
      }));
      if (atNzbResults.length) console.log(`  📰 AnimeTosho NZB: ${atNzbResults.length} results`);
    }
  }
  nzbResults = [...atNzbResults];

  // ===== Source 2: NZBgeek =====
  const hasNzbgeek = user.nzbgeek_api_key && user.nzbgeek_enabled !== false;
  if (hasNzbgeek) {
    let geekResults = [];

    // Determine if this is anime (from offline-db)
    let isAnime = false;
    if (fullId.startsWith('at:') || fullId.startsWith('kitsu:') || fullId.startsWith('anilist:')) {
      isAnime = true;
    } else if (fullId.startsWith('tt')) {
      // Check if IMDb ID is in anime offline-db
      const imdbBase = fullId.split(':')[0];
      for (const [, rec] of offlineDB.byAniList) {
        if (rec.imdb === imdbBase) { isAnime = true; break; }
      }
    }

    const cat = isAnime ? '5070' : null; // anime cat or all

    if (isMovie && fullId.startsWith('tt')) {
      // Movie: search by IMDb ID
      const imdbId = fullId.split(':')[0];
      geekResults = await nzbgeekMovieSearch(imdbId, user.nzbgeek_api_key);
    } else if (tvdbId) {
      // Series: search by TVDB ID
      geekResults = await nzbgeekSearch(tvdbId, season, episode, user.nzbgeek_api_key, cat);
    }

    if (geekResults.length) {
      // Deduplicate by name similarity (rough)
      const existingNames = new Set(nzbResults.map(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
      const newGeek = geekResults.filter(r => {
        const norm = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return !existingNames.has(norm);
      });
      nzbResults = [...nzbResults, ...newGeek];
      console.log(`  📰 NZBgeek: +${newGeek.length} unique (${geekResults.length - newGeek.length} duplicates)`);
    }
  }

  if (!nzbResults.length) {
    return res.json({ streams: [] });
  }

  // ===== Sort NZB using user preferences (without magnet filter) =====
  let sorted = nzbResults;
  if (user?.customSortEnabled) {
    const resOrder = user.resPriority || DEFAULT_RESOLUTIONS;
    const langOrder = (user.langPriority || []).map(l => l.toLowerCase());
    const excludedRes = new Set((user.excludedResolutions || []).map(r => r.toLowerCase()));

    // Filter excluded resolutions
    sorted = sorted.filter(t => {
      const res = detectQuality(t.name);
      if (res && excludedRes.has(res.toLowerCase())) return false;
      return true;
    });

    // Sort by: language priority → resolution priority → grabs/seeders
    sorted.sort((a, b) => {
      // Language priority (from NZBgeek language/subs attrs + title)
      if (langOrder.length) {
        const aLangScore = getLangScore(a, langOrder);
        const bLangScore = getLangScore(b, langOrder);
        if (aLangScore !== bLangScore) return aLangScore - bLangScore;
      }

      // Resolution priority
      const aRes = detectQuality(a.name);
      const bRes = detectQuality(b.name);
      const aResIdx = aRes ? resOrder.indexOf(aRes) : -1;
      const bResIdx = bRes ? resOrder.indexOf(bRes) : -1;
      const aResPri = aResIdx >= 0 ? aResIdx : resOrder.length;
      const bResPri = bResIdx >= 0 ? bResIdx : resOrder.length;
      if (aResPri !== bResPri) return aResPri - bResPri;

      // By grabs or seeders
      return (parseInt(b.grabs) || parseInt(b.seeders) || 0) - (parseInt(a.grabs) || parseInt(a.seeders) || 0);
    });
  }
  const topResults = sorted.slice(0, 20);

  // ===== Generate TorBox NZB streams =====
  const streams = [];
  const epNum = isMovie ? 0 : episode;

  for (const t of topResults) {
    const name = t.name || '';
    const quality = detectQuality(name);
    const tags = [quality].filter(Boolean);
    const line1 = tags.join(' · ');
    const sourceLabel = t.source === 'nzbgeek' ? '📰 NZBgeek' : '📡 AT';

    // Build info line: source | 🔊 lang | 💬 subs | 📦 size | 📅 date
    const infoParts = [sourceLabel];

    // Filter languages based on user's langPriority (show only matching languages)
    const userLangs = (user?.langPriority || []).map(l => l.toLowerCase());
    if (t.language) {
      const filtered = filterLangString(t.language, userLangs);
      if (filtered) infoParts.push(`🔊 ${filtered}`);
    }
    if (t.subs) {
      const filtered = filterLangString(t.subs, userLangs);
      if (filtered) infoParts.push(`💬 ${filtered}`);
    }
    infoParts.push(`📦 ${t.filesize || '?'}`);
    if (t.usenetdate) {
      try {
        const d = new Date(t.usenetdate);
        if (!isNaN(d)) {
          const days = Math.floor((Date.now() - d.getTime()) / 86400000);
          const age = days < 1 ? '<1d' : days < 30 ? `${days}d` : days < 365 ? `${Math.floor(days / 7)}w` : `${Math.floor(days / 365)}y`;
          infoParts.push(`📅 ${age}`);
        }
      } catch {}
    }
    const infoLine = infoParts.join(' | ');
    const title = `${line1 ? line1 + '\n' : ''}${name}\n${infoLine}`;

    // Use nzb_url directly — AnimeTosho and NZBgeek both provide working URLs
    const nzbUrl = t.nzb_url;

    if (nzbUrl) {
      streams.push({
        name: `📡 NZB`,
        title,
        url: `${BASE_URL}/${token}/play-nzb/${storeNZB(nzbUrl, t.name)}/${epNum}/video.mp4`,
        behaviorHints: { bingeGroup: 'nzb-search', notWebReady: true }
      });
    }
  }

  console.log(`  📤 NZB Streams: ${streams.length}`);
  res.json({ streams });
});

// ===== Health =====
app.get('/health', (req, res) => {
  const rss = getRssStats();
  const users = config.listUsers();
  const nekobtUsers = users.filter(t => {
    const u = config.getUser(t);
    return u?.nekobt_api_key;
  }).length;
  res.json({
    status: 'ok', uptime: process.uptime(),
    animeCount: todayAnimeCache.length,
    users: users.length,
    nekobtUsers,
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
