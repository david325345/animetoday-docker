const express = require('express');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');
const axios = require('axios');

const config = require('./lib/config');
const { fetchAnimeSchedule, formatTimeCET: simklFormatTime, getDayLabel } = require('./lib/simkl');
const { loadOfflineDB, loadAnimeLists, loadMappingCache, resolveToAniDB, resolveEpisode, resolveViaTVDB, parseEpisodeAndSeason, weeklyUpdate, offlineDB, getTVDBFromAniDB, getTVDBInfoFromAniDB } = require('./lib/idmap');
const { detectQuality, sortByGroupPriority, DEFAULT_GROUPS, DEFAULT_RESOLUTIONS } = require('./lib/search');
const { getRDStream, rdInProgress, getCacheKey, serveLoadingVideo, DOWNLOADING_VIDEO_URL, checkInstantAvailability } = require('./lib/realdebrid');
const { generateAllPosters } = require('./lib/posters');
const todayAdded = require('./lib/today-added');
const { formatTimeCET } = require('./lib/simkl');
const { startRssFetcher, clearRssIndex, searchRssIndex, getRssStats } = require('./lib/rss');
const { getTBStatus, getTBStream, getTBNZBStream, checkTBCached, tbInProgress } = require('./lib/torbox');
const { validateApiKey: validateNekobtKey } = require('./lib/nekobt');
const { searchByTVDB: nzbgeekSearch, searchByIMDb: nzbgeekMovieSearch, validateApiKey: validateNzbgeekKey } = require('./lib/nzbgeek');
// SeaDex / NekoBT direct search removed — all torrent results come from our own indexer now.
// API endpoints and lib files are kept for backward compatibility / future re-enabling.

process.on('uncaughtException', (err) => { console.error('⚠️ Uncaught:', err.message); console.error(err.stack); });
process.on('unhandledRejection', (err) => { console.error('⚠️ Unhandled:', err?.message || err); });

const PORT = process.env.PORT || 3002;
const BASE_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const INDEXER_URL = (process.env.INDEXER_URL || 'https://nimetodex.duckdns.org').replace(/\/$/, '');
const ONDEMAND_VIDEO_URL = process.env.ONDEMAND_VIDEO_URL || 'https://raw.githubusercontent.com/david325345/animetoday-docker/main/public/search-ondemand.mp4';
const R2_NZB_BASE = process.env.R2_NZB_BASE || 'https://pub-4a78ba5831734d77a4c5c6762c14d4a2.r2.dev';
const NZB_REFRESH_TOKEN = process.env.NZB_REFRESH_TOKEN || '';

// Public trackers for P2P (direct Stremio playback) — appended to torrent's own trackers
const P2P_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

console.log('═══════════════════════════════════════════');
console.log('  🎬 Nyaa + Anime Today v5.0');
console.log('═══════════════════════════════════════════');
console.log(`  PORT: ${PORT}`);
console.log(`  URL:  ${BASE_URL}`);
console.log(`  IDX:  ${INDEXER_URL}`);

// ===== State =====
let todayAnimeCache = [];

// ===== Cache update =====
async function updateCache() {
  console.log('🔄 Updating anime cache...');
  const t0 = Date.now();
  try {
    const schedules = await fetchAnimeSchedule();
    // Update cache IMMEDIATELY so catalog is available with SIMKL posters
    // while we generate enhanced posters in the background.
    todayAnimeCache = schedules;
    const withImdb = schedules.filter(s => s.imdbId).length;
    console.log(`✅ Cache: ${todayAnimeCache.length} anime, ${withImdb} with IMDb (${((Date.now() - t0) / 1000).toFixed(1)}s, posters generating...)`);

    // Poster generation runs after; mutates schedule entries in-place
    // (each gets generatedPoster assigned), so the cache benefits without rewriting.
    await generateAllPosters(schedules);
    console.log(`✅ Posters generated for ${schedules.length} anime`);
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

// ===== Stremio addon configure endpoints =====
// When user clicks the gear icon in Stremio, it opens BASE_URL/{token}/configure (or similar).
// We redirect to the main web UI with ?token=XXX so frontend can auto-login.
app.get('/:token/configure', (req, res) => {
  res.redirect(302, `/?token=${encodeURIComponent(req.params.token)}`);
});
// Also handle per-addon configure paths
app.get('/:token/today/configure', (req, res) => {
  res.redirect(302, `/?token=${encodeURIComponent(req.params.token)}`);
});
app.get('/:token/nyaa/configure', (req, res) => {
  res.redirect(302, `/?token=${encodeURIComponent(req.params.token)}`);
});
app.get('/:token/nzb/configure', (req, res) => {
  res.redirect(302, `/?token=${encodeURIComponent(req.params.token)}`);
});

// ===== USER API =====
// Auth: Login with username/password
app.post('/api/auth/login', express.json(), (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const acc = config.authenticateUser(username, password);
  if (!acc) return res.status(401).json({ error: 'Invalid credentials' });
  if (acc.active === false) return res.status(403).json({ error: 'Account deactivated' });
  res.json({
    success: true,
    token: acc.token,
    username,
    role: acc.role,
    permissions: acc.permissions
  });
});

// Get current user info by token
app.get('/api/user/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const acc = config.getAccountByToken(req.params.token);
  res.json({
    hidden_anime: user.hidden_anime,
    has_rd: !!user.rd_api_key,
    created: user.created,
    role: acc?.role || 'user',
    permissions: acc?.permissions || {},
    username: acc?.username || ''
  });
});

// ===== Admin API =====
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.body?.adminToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const acc = config.getAccountByToken(token);
  if (!acc || acc.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });
  next();
}

app.get('/api/admin/accounts', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const acc = config.getAccountByToken(token);
  if (!acc || acc.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });
  res.json({ accounts: config.listAccounts() });
});

app.post('/api/admin/create-account', express.json(), (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const acc = config.getAccountByToken(token);
  if (!acc || acc.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });

  const { username, password, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  const created = config.createAccount(username, password, permissions);
  if (!created) return res.status(409).json({ error: 'Username already exists' });
  res.json({ success: true, token: created.token });
});

app.post('/api/admin/delete-account', express.json(), (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const acc = config.getAccountByToken(token);
  if (!acc || acc.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });

  const { username } = req.body;
  const ok = config.deleteAccount(username);
  if (!ok) return res.status(400).json({ error: 'Cannot delete this account' });
  res.json({ success: true });
});

app.post('/api/admin/update-permissions', express.json(), (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const acc = config.getAccountByToken(token);
  if (!acc || acc.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });

  const { username, permissions } = req.body;
  const ok = config.updateAccountPermissions(username, permissions);
  if (!ok) return res.status(400).json({ error: 'Cannot update this account' });
  res.json({ success: true });
});

app.post('/api/admin/toggle-account', express.json(), (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const acc = config.getAccountByToken(token);
  if (!acc || acc.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });

  const { username, active } = req.body;
  const ok = config.toggleAccountActive(username, active);
  if (!ok) return res.status(400).json({ error: 'Cannot modify this account' });
  res.json({ success: true });
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
    res.json({ connected: true, rd_enabled: user.rd_enabled !== false, username: resp.data.username, premium: resp.data.premium > 0, expiration: resp.data.expiration });
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
        return res.json({ connected: true, rd_enabled: user.rd_enabled !== false, username: retry.data.username, premium: retry.data.premium > 0, expiration: retry.data.expiration });
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

app.post('/api/rd/toggle', express.json(), (req, res) => {
  const { token, enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.rd_enabled = !!enabled;
  config.saveUser(token, user);
  res.json({ success: true });
});

// ===== P2P (direct Stremio playback) =====
app.get('/api/p2p/status/:token', (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.json({ enabled: false });
  res.json({ enabled: !!user.p2p_enabled });
});

app.post('/api/p2p/toggle', express.json(), (req, res) => {
  const { token, enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Permission check — torrents permission required to enable P2P
  const account = config.getAccountByToken(token);
  const perms = account?.permissions || {};
  if (enabled && !perms.torrents) {
    return res.status(403).json({ error: 'Torrents permission required' });
  }
  user.p2p_enabled = !!enabled;
  config.saveUser(token, user);
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
      id: s.simklId, anilistId: s.anilistId, episode: s.episode, airingAt: s.airingAt,
      title: s.title, genres: s.genres, score: s.anilistScore || s.malScore,
      poster: s.generatedPoster ? `${BASE_URL}${s.generatedPoster}` : s.posterUrl,
      hidden: hidden.includes(s.simklId),
      dayOffset: s.dayOffset,
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
  // Migrate legacy users: 'custom' → 'qualityThenSeeders'; map customSortEnabled to all per-filter toggles ON.
  let sortMode = user.sortMode;
  if (!sortMode || sortMode === 'custom') {
    sortMode = 'qualityThenSeeders';
  }
  // Migration: if user previously had customSortEnabled=true and any filter list set, default toggles ON for those.
  const hadLegacyCustom = !!user.customSortEnabled;
  res.json({
    sortMode,
    // Per-filter toggles
    groupsEnabled: typeof user.groupsEnabled === 'boolean' ? user.groupsEnabled : hadLegacyCustom,
    resEnabled: typeof user.resEnabled === 'boolean' ? user.resEnabled : hadLegacyCustom,
    excludeResEnabled: typeof user.excludeResEnabled === 'boolean' ? user.excludeResEnabled : hadLegacyCustom,
    langsEnabled: typeof user.langsEnabled === 'boolean' ? user.langsEnabled : hadLegacyCustom,
    // Lists (used when corresponding toggle is ON)
    groupPriority: user.groupPriority || DEFAULT_GROUPS,
    resPriority: user.resPriority || DEFAULT_RESOLUTIONS,
    langPriority: user.langPriority || [],
    excludedResolutions: user.excludedResolutions || [],
    // Top-level toggles (apply across all modes)
    dubFirst: user.dubFirst || false,
    cachedFirst: user.cachedFirst || false,
    langFilterEnabled: user.langFilterEnabled || false,
    langFilterCodes: user.langFilterCodes || ['en', 'cs'],
    defaultGroups: DEFAULT_GROUPS,
    defaultResolutions: DEFAULT_RESOLUTIONS,
    defaultLangs: []
  });
});

app.post('/api/sort-prefs/:token', express.json(), (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const {
    sortMode,
    groupsEnabled, resEnabled, excludeResEnabled, langsEnabled,
    groupPriority, resPriority, langPriority, excludedResolutions,
    dubFirst, cachedFirst,
    langFilterEnabled, langFilterCodes
  } = req.body;
  const VALID_MODES = ['qualityThenSeeders', 'qualityThenSize', 'seeders', 'size'];
  if (typeof sortMode === 'string' && VALID_MODES.includes(sortMode)) {
    user.sortMode = sortMode;
    user.customSortEnabled = false; // legacy flag kept off — no longer used for sort logic
  }
  if (typeof groupsEnabled === 'boolean') user.groupsEnabled = groupsEnabled;
  if (typeof resEnabled === 'boolean') user.resEnabled = resEnabled;
  if (typeof excludeResEnabled === 'boolean') user.excludeResEnabled = excludeResEnabled;
  if (typeof langsEnabled === 'boolean') user.langsEnabled = langsEnabled;
  if (Array.isArray(groupPriority)) user.groupPriority = groupPriority;
  if (Array.isArray(resPriority)) user.resPriority = resPriority;
  if (Array.isArray(langPriority)) user.langPriority = langPriority;
  if (Array.isArray(excludedResolutions)) user.excludedResolutions = excludedResolutions;
  if (typeof dubFirst === 'boolean') user.dubFirst = dubFirst;
  if (typeof cachedFirst === 'boolean') user.cachedFirst = cachedFirst;
  if (typeof langFilterEnabled === 'boolean') user.langFilterEnabled = langFilterEnabled;
  if (Array.isArray(langFilterCodes)) {
    // Sanitize: only ISO codes 2-3 chars, lowercase
    user.langFilterCodes = langFilterCodes
      .filter(c => typeof c === 'string' && /^[a-z]{2,3}$/i.test(c))
      .map(c => c.toLowerCase())
      .slice(0, 30); // hard limit
  }
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
  res.json({ connected: true, ...status, tb_use_torrents: user.tb_use_torrents ?? false, tb_use_nzb: user.tb_use_nzb ?? true, tb_cache_check: user.tb_cache_check !== false });
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
  if (field === 'tb_cache_check') user.tb_cache_check = !!value;
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
  if (!user) return res.json({ enabled: false, indexer_only: false, indexer_catalog: false, subtitles_enabled: false });
  res.json({ enabled: user.indexer_enabled || false, indexer_only: user.indexer_only || false, indexer_catalog: user.indexer_catalog || false, subtitles_enabled: user.subtitles_enabled || false });
});

app.post('/api/indexer/toggle', express.json(), (req, res) => {
  const { token, enabled, indexer_only, indexer_catalog, subtitles_enabled } = req.body;
  const user = config.getUser(token);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (enabled !== undefined) user.indexer_enabled = !!enabled;
  if (indexer_only !== undefined) user.indexer_only = !!indexer_only;
  if (indexer_catalog !== undefined) user.indexer_catalog = !!indexer_catalog;
  if (subtitles_enabled !== undefined) user.subtitles_enabled = !!subtitles_enabled;
  config.saveUser(token, user);
  res.json({ success: true });
});

// ===== ON-DEMAND SEARCH TRIGGER =====
app.get('/:token/ondemand/:type/:id/video.mp4', async (req, res) => {
  const { token, type, id: fullId } = req.params;
  const user = config.getUser(token);
  const isMovie = type === 'movie';

  // Parse IDs from fullId
  const params = {};
  if (fullId.startsWith('tt')) params.imdb = fullId.split(':')[0];

  // Try to resolve more IDs from offline-db
  const { season, episode } = parseEpisodeAndSeason(fullId);
  if (fullId.startsWith('tt')) {
    const imdbBase = fullId.split(':')[0];
    for (const [, rec] of offlineDB.byAniList) {
      if (rec.imdb === imdbBase) {
        if (rec.anilist) params.anilist = rec.anilist;
        if (rec.anidb) params.anidb = rec.anidb;
        if (rec.tvdb) params.tvdb = rec.tvdb;
        break;
      }
    }
  } else if (fullId.startsWith('anilist:')) {
    const alId = parseInt(fullId.split(':')[1]);
    params.anilist = alId;
    const rec = offlineDB.byAniList.get(alId);
    if (rec) {
      if (rec.anidb) params.anidb = rec.anidb;
      if (rec.tvdb) params.tvdb = rec.tvdb;
    }
  } else if (fullId.startsWith('at:')) {
    const alId = parseInt(fullId.split(':')[1]);
    params.anilist = alId;
    const rec = offlineDB.byAniList.get(alId);
    if (rec) {
      if (rec.anidb) params.anidb = rec.anidb;
      if (rec.tvdb) params.tvdb = rec.tvdb;
    }
  }

  if (season != null && !isMovie) params.season = season;
  if (episode && !isMovie) params.episode = episode;

  // Fire on-demand search in background (don't await)
  const searchParams = new URLSearchParams(params);
  console.log(`  🔍 On-demand trigger: ${searchParams.toString()}`);
  axios.post(`${INDEXER_URL}/api/ondemand-search-by-imdb`, params, { timeout: 30000 })
    .then(r => console.log(`  🔍 On-demand done: ${r.data?.added || 0} added`))
    .catch(err => console.log(`  🔍 On-demand error: ${err.message}`));

  // Redirect to placeholder video immediately
  res.redirect(302, ONDEMAND_VIDEO_URL);
});
app.get('/:token/play/:hash/:episode/video.mp4', async (req, res) => {
  const user = config.getUser(req.params.token);
  if (!user?.rd_api_key) return serveLoadingVideo(res);

  const magnet = magnetStore.get(req.params.hash);
  if (!magnet) return serveLoadingVideo(res);

  // Parse episode param: "fi3" = fileIdx 3, "5" = episode 5
  const epParam = req.params.episode;
  const isFileIdx = epParam.startsWith('fi');
  const episode = isFileIdx ? parseInt(epParam.slice(2)) : (parseInt(epParam) || 0);

  const cacheKey = getCacheKey(magnet, user.rd_api_key) + (isFileIdx ? `_fi${episode}` : episode ? `_ep${episode}` : '');

  // Already in progress
  if (rdInProgress.has(cacheKey)) return serveLoadingVideo(res);

  rdInProgress.add(cacheKey);

  const timeoutP = new Promise(r => setTimeout(() => r(null), 8000));
  const rdP = getRDStream(magnet, user.rd_api_key, episode, isFileIdx);
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

  // Parse episode param: "fi3" = fileIdx 3, "5" = episode 5
  const epParam = req.params.episode;
  const isFileIdx = epParam.startsWith('fi');
  const episode = isFileIdx ? parseInt(epParam.slice(2)) : (parseInt(epParam) || 0);

  const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/i);
  const cacheKey = `tb:${(hashMatch?.[1] || '').toLowerCase()}:${isFileIdx ? 'fi' : ''}${episode}`;

  // Already in progress — let other request finish, serve loading video
  if (tbInProgress.has(cacheKey)) return serveLoadingVideo(res);

  tbInProgress.add(cacheKey);

  // Race full TB flow against an 8s timeout. If TB doesn't deliver in 8s,
  // serve loading video and let the work finish in background (cache for next click).
  const timeoutP = new Promise(r => setTimeout(() => r(null), 8000));
  const tbP = getTBStream(magnet, user.tb_api_key, episode, isFileIdx);
  const url = await Promise.race([tbP, timeoutP]);

  if (url) {
    tbInProgress.delete(cacheKey);
    return res.redirect(302, url);
  }

  // Serve loading video, let TB finish in background
  serveLoadingVideo(res);
  tbP.then(u => { if (u) console.log('  TB: ✅ Background done, cached'); })
    .catch(() => {}).finally(() => tbInProgress.delete(cacheKey));
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

// ===== NZB REFRESH TRIGGER =====
app.get('/:token/nzb-refresh/:imdb/:season/:episode/video.mp4', async (req, res) => {
  const { imdb, season, episode } = req.params;

  const params = { imdb };
  if (season != null && season !== '') params.season = parseInt(season);
  if (episode && episode !== '0') params.episode = parseInt(episode);

  console.log(`  📰 NZB refresh trigger: ${imdb} S${season}E${episode}`);

  // Fire both refreshes in background (don't await)
  (async () => {
    try {
      // First: get tosho_results infohashes from search
      const searchParams = new URLSearchParams(params);
      const searchResp = await axios.get(`${INDEXER_URL}/search?${searchParams.toString()}`, { timeout: 8000 });
      const toshoResults = searchResp.data?.tosho_results || [];
      const infohashes = toshoResults.map(t => t.infohash).filter(h => h && h.length === 40);

      const authHeaders = { Authorization: `Bearer ${NZB_REFRESH_TOKEN}`, 'Content-Type': 'application/json' };

      // Parallel: Geek + Tosho refresh
      const tasks = [
        axios.post(`${INDEXER_URL}/api/nzb/refresh-by-imdb`, params, { headers: authHeaders, timeout: 30000 })
          .then(r => console.log(`  📰 Geek refresh: ${r.data?.found || 0} found, ${r.data?.uploaded || 0} uploaded`))
          .catch(err => console.log(`  📰 Geek refresh error: ${err.message}`)),
      ];

      if (infohashes.length > 0) {
        tasks.push(
          axios.post(`${INDEXER_URL}/api/tosho/refresh-by-infohashes`, { infohashes: infohashes.slice(0, 100) }, { headers: authHeaders, timeout: 60000 })
            .then(r => console.log(`  📡 Tosho refresh: ${r.data?.uploaded || 0} uploaded, ${r.data?.unavailable || 0} unavailable`))
            .catch(err => console.log(`  📡 Tosho refresh error: ${err.message}`))
        );
      } else {
        console.log(`  📡 Tosho refresh: skipped (no infohashes)`);
      }

      await Promise.allSettled(tasks);
      console.log(`  📰 NZB refresh complete`);
    } catch (err) {
      console.log(`  📰 NZB refresh error: ${err.message}`);
    }
  })();

  res.redirect(302, ONDEMAND_VIDEO_URL);
});

// ===== STREMIO: ANIME TODAY ADDON =====
app.get('/:token/today/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nyaa.anime.today.v8',
    version: '8.1.0',
    name: 'Anime Today',
    description: 'Anime schedule from SIMKL — today + 2 days ahead with posters and ratings.',
    logo: `${BASE_URL}/logo.png`,
    resources: ['catalog', 'meta'],
    types: ['series'],
    catalogs: [{ type: 'series', id: 'anime-today', name: 'Anime Schedule', extra: [{ name: 'skip', isRequired: false }] }],
    idPrefixes: ['at:'],
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});

app.get('/:token/today/catalog/:type/:id.json', (req, res) => {
  console.log(`=== TODAY CATALOG === type=${req.params.type} id=${req.params.id}`);
  if (req.params.id !== 'anime-today') return res.json({ metas: [] });
  const user = config.getUser(req.params.token);
  const hidden = user?.hidden_anime || [];

  // Sort by airing time
  const sorted = [...todayAnimeCache]
    .filter(s => !hidden.includes(s.simklId))
    .sort((a, b) => new Date(a.airingAt) - new Date(b.airingAt));

  // Build metas with day separators
  const metas = [];
  let lastDay = -1;

  for (const s of sorted) {
    // Insert separator when day changes (skip for today = day 0)
    if (s.dayOffset > 0 && s.dayOffset !== lastDay) {
      const sepPoster = `${BASE_URL}/posters/sep_day${s.dayOffset}.png`;
      metas.push({
        id: `at:sep:${s.dayOffset}`,
        type: 'series',
        name: getDayLabel(s.dayOffset),
        poster: sepPoster,
        description: '',
        behaviorHints: { defaultVideoId: 'none' }
      });
    }
    lastDay = s.dayOffset;

    // Anime entry
    const poster = s.generatedPoster ? `${BASE_URL}${s.generatedPoster}` : s.posterUrl;
    const bg = s.fanartUrl || poster;
    const time = formatTimeCET(s.airingAt);
    const id = s.imdbId || `at:${s.anilistId || s.simklId}`;

    metas.push({
      id, type: 'series',
      name: s.title,
      poster: poster || 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image',
      background: bg || poster,
      description: `${time} · Epizoda ${s.episode}\n\n${(s.overview || '').replace(/<[^>]*>/g, '')}`,
      genres: s.genres || [],
      releaseInfo: `${time} · Ep ${s.episode}`,
      imdbRating: s.anilistScore || (s.malScore ? parseFloat(s.malScore).toFixed(1) : undefined),
      links: [{ name: 'SIMKL', category: 'simkl', url: `https://simkl.com/anime/${s.simklId}` }]
    });
  }

  res.json({ metas });
  console.log(`  📅 Anime Today catalog (${req.params.type}): ${metas.length} items returned`);
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
    } catch {}
  }

  // === Step 2: Name search ===
  function cleanAnimeName(name) {
    if (!name) return '';
    return name
      .replace(/\s*(\d+(?:st|nd|rd|th))?\s*(Season|Part|Cour|Series|Phase|Chapter|Arc)\s*\d*\s*$/i, '')
      .replace(/\s+\d+$/, '')
      .replace(/\s+[IVXLC]+$/, '')
      .replace(/[!?♪♫★☆~※♥❤.,;'"`(){}[\]]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  const searchNames = [];
  for (const name of nameVariants) {
    if (!name) continue;
    const clean = cleanAnimeName(name);
    if (clean && clean.length >= 3 && !searchNames.includes(clean)) searchNames.push(clean);
    const noSubtitle = clean.split(/[:\-–—]/)[0].trim();
    if (noSubtitle && noSubtitle !== clean && noSubtitle.length >= 3 && !searchNames.includes(noSubtitle)) searchNames.push(noSubtitle);
  }

  for (const searchName of searchNames) {
    try {
      const searchResp = await axios.get('https://api.themoviedb.org/3/search/tv', {
        params: { api_key: tmdbKey, query: searchName, language: 'en-US' }, timeout: 5000
      });
      const results = searchResp.data?.results;
      if (!results?.length) continue;
      const sorted = [...results].sort((a, b) => {
        const aAnim = (a.genre_ids || []).includes(16) ? 1 : 0;
        const bAnim = (b.genre_ids || []).includes(16) ? 1 : 0;
        return bAnim - aAnim || (b.popularity || 0) - (a.popularity || 0);
      });
      for (const result of sorted.slice(0, 3)) {
        try {
          const extResp = await axios.get(`https://api.themoviedb.org/3/tv/${result.id}/external_ids`, {
            params: { api_key: tmdbKey }, timeout: 5000
          });
          const imdbId = extResp.data?.imdb_id;
          if (imdbId && imdbId.startsWith('tt')) {
            tmdbImdbCache.set(cacheKey, imdbId);
            if (offRec && !offRec.imdb) offRec.imdb = imdbId;
            return imdbId;
          }
        } catch {}
      }
    } catch {}
  }

  tmdbImdbCache.set(cacheKey, null);
  return null;
}

app.get('/:token/today/meta/:type/:id.json', async (req, res) => {
  const atId = req.params.id;
  const type = req.params.type;
  console.log(`=== META === type=${type} id=${atId}`);

  // Separator items — return empty meta
  if (atId.startsWith('at:sep:')) return res.json({ meta: null });

  if (!atId.startsWith('at:')) return res.json({ meta: null });

  const parsedId = parseInt(atId.split(':')[1]);
  if (!parsedId) return res.json({ meta: null });

  // Find in cache — by anilistId or simklId
  const schedule = todayAnimeCache.find(s => s.anilistId === parsedId || s.simklId === parsedId);

  // Try IMDb from SIMKL data first
  let imdbId = schedule?.imdbId;

  console.log(`  🔍 ID: ${parsedId}, IMDb: ${imdbId || 'none'}, schedule: ${schedule ? 'yes' : 'no'}`);

  // === Strategy 1: IMDb exists → full Cinemeta proxy ===
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
  const currentEp = schedule?.episode || 1;
  const totalEp = schedule?.totalEpisodes || currentEp;
  const epCount = Math.max(currentEp, totalEp);

  console.log(`  📺 Generating ${epCount} episodes (no IMDb, using at: IDs)`);

  const videos = [];
  for (let ep = 1; ep <= epCount; ep++) {
    videos.push({
      id: `at:${parsedId}:1:${ep}`,
      title: `Episode ${ep}`,
      season: 1,
      episode: ep,
    });
  }

  const poster = schedule?.generatedPoster ? `${BASE_URL}${schedule.generatedPoster}` : (schedule?.posterUrl || 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image');
  const bg = schedule?.fanartUrl || poster;
  const time = schedule ? formatTimeCET(schedule.airingAt) : '';

  const meta = {
    id: atId,
    type: 'series',
    name: schedule?.title || 'Unknown',
    poster,
    background: bg || poster,
    description: schedule ? `${time} · Epizoda ${schedule.episode}\n\n${(schedule.overview || '').replace(/<[^>]*>/g, '')}` : '',
    genres: schedule?.genres || [],
    releaseInfo: schedule ? `${time} · Ep ${schedule.episode}` : '',
    imdbRating: schedule?.anilistScore || (schedule?.malScore ? parseFloat(schedule.malScore).toFixed(1) : undefined),
    videos,
    links: schedule ? [{ name: 'SIMKL', category: 'simkl', url: `https://simkl.com/anime/${schedule.simklId}` }] : []
  };

  console.log(`  📤 Meta (fallback): ${meta.name} — ${videos.length} videos with at: IDs`);
  res.json({ meta });
});

// ===== STREMIO: NYAA SEARCH ADDON =====
app.get('/:token/nyaa/manifest.json', (req, res) => {
  const user = config.getUser(req.params.token);
  const resources = ['stream', 'meta'];
  if (user?.subtitles_enabled) {
    resources.push({ name: 'subtitles', types: ['series', 'movie'], idPrefixes: ['tt'] });
  }
  res.json({
    id: 'cz.nyaa.search.v7',
    version: '7.5.0',
    name: 'NimeToDex',
    description: 'Anime torrent indexer + RealDebrid/TorBox. Funguje s Cinemeta/Kitsu/Anime Today.',
    logo: `${BASE_URL}/logo-nyaa.png`,
    resources,
    types: ['series', 'movie'],
    catalogs: [
      { type: 'series', id: 'nimetodex-today', name: 'NimeToDex — Added today', extra: [{ name: 'skip' }] },
      { type: 'movie', id: 'nimetodex-today', name: 'NimeToDex — Added today', extra: [{ name: 'skip' }] }
    ],
    idPrefixes: ['at:', 'kitsu:', 'tt', 'tvdb:', 'anilist:', 'mal:'],
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});

// ===== NimeToDex: Today Added catalog =====
app.get('/:token/nyaa/catalog/:type/:id.json', async (req, res) => {
  const { token, type, id } = req.params;
  if (id !== 'nimetodex-today') return res.json({ metas: [] });

  const user = config.getUser(token);
  if (!user?.indexer_catalog) return res.json({ metas: [] });

  try {
    const items = await todayAdded.getTodayAdded();
    const typeMap = { TV: 'series', OVA: 'series', SPECIAL: 'series', ONA: 'series', MUSIC: 'series', MOVIE: 'movie' };

    const metas = items
      .filter(item => {
        const stremioType = typeMap[item.type] || 'series';
        return stremioType === type && item.imdb_id;
      })
      .map(item => todayAdded.buildMeta(item, BASE_URL))
      .filter(Boolean);

    console.log(`  📋 Today catalog (${type}): ${metas.length} items`);
    res.json({ metas, cacheMaxAge: 3600 });
  } catch (err) {
    console.log(`  📋 Today catalog error: ${err.message}`);
    res.json({ metas: [] });
  }
});

// ===== NimeToDex: Subtitles proxy =====
app.get('/:token/nyaa/subtitles/:type/:id.json', async (req, res) => {
  const { token, type, id } = req.params;
  const user = config.getUser(token);
  if (!user?.subtitles_enabled) return res.json({ subtitles: [] });

  try {
    const resp = await axios.get(`${INDEXER_URL}/subtitles/${type}/${id}.json`, { timeout: 8000 });
    const subs = resp.data?.subtitles || [];
    if (subs.length) console.log(`  💬 Subtitles: ${subs.length} for ${type}/${id}`);
    res.json({ subtitles: subs });
  } catch (err) {
    console.log(`  💬 Subtitles error: ${err.message}`);
    res.json({ subtitles: [] });
  }
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

    const schedule = todayAnimeCache.find(s => s.anilistId === anilistId || s.simklId === anilistId);
    const offRec = offlineDB.byAniList.get(anilistId);
    let imdbId = schedule?.imdbId || offRec?.imdb;

    console.log(`  🔍 AT: AniList ${anilistId}, IMDb: ${imdbId || 'none'}`);

    if (!imdbId && schedule) {
      const names = [schedule.title, schedule.enTitle].filter(Boolean);
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
    const totalEp = schedule?.totalEpisodes || currentEp;
    const epCount = Math.max(currentEp, totalEp);
    const videos = [];
    for (let ep = 1; ep <= epCount; ep++) {
      videos.push({ id: `at:${anilistId}:1:${ep}`, title: `Episode ${ep}`, season: 1, episode: ep });
    }
    const meta = {
      id: fullId, type: 'series',
      name: schedule?.title || offRec?.title || 'Unknown',
      description: schedule?.overview ? schedule.overview.replace(/<[^>]*>/g, '') : '',
      genres: schedule?.genres || [],
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
  const account = config.getAccountByToken(token);
  const userPerms = account?.permissions || {};
  const isMovie = type === 'movie';

  console.log(`=== STREAM === type=${type} id=${fullId}`);

  let { season, episode } = parseEpisodeAndSeason(fullId);

  // Detect if episode was explicitly provided in the ID
  const idParts = fullId.split(':');
  const hasExplicitEpisode = fullId.startsWith('at:') ? idParts.length >= 3 :
    fullId.startsWith('kitsu:') ? idParts.length >= 4 :
    fullId.startsWith('tt') ? idParts.length >= 3 :
    fullId.startsWith('anilist:') ? idParts.length >= 4 :
    fullId.startsWith('mal:') ? idParts.length >= 4 :
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
        const rec = offlineDB.byAniList.get(s.anilistId);
        if (rec?.imdb === imdbBase) { episode = s.episode; season = 1; matchedByImdb = true; console.log(`  📅 Today (imdb): ${imdbBase} → ep${episode}`); break; }
      }
      // 2. Fallback: resolve IMDb → AniDB via anime-lists, then match AniDB in cache
      if (!matchedByImdb) {
        try {
          const resolved = await resolveToAniDB('series', imdbBase);
          if (resolved?.anidb) {
            for (const s of todayAnimeCache) {
              const rec = offlineDB.byAniList.get(s.anilistId);
              if (rec?.anidb === resolved.anidb) { episode = s.episode; season = 1; matchedByImdb = true; console.log(`  📅 Today (anidb): ${imdbBase} → AniDB ${resolved.anidb} → ep${episode}`); break; }
            }
          }
        } catch {}
      }
    }
    if (!matchedByImdb) {
      for (const s of todayAnimeCache) {
        const rec = offlineDB.byAniList.get(s.anilistId);
        if (kitsuId && rec?.kitsu === kitsuId) { episode = s.episode; season = 1; console.log(`  📅 Today: kitsu:${kitsuId} → ep${episode}`); break; }
        if (anilistIdNum && s.anilistId === anilistIdNum) { episode = s.episode; season = 1; console.log(`  📅 Today: anilist:${anilistIdNum} → ep${episode}`); break; }
      }
    }
  }

  // ===== UNIFIED ID RESOLVE (before any search) =====
  const resolved = { anidbId: null, anilistId: null, tvdbId: null, malId: null, kitsuId: null, names: [], title: null };

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
    const sched = todayAnimeCache.find(s => s.anilistId === alId);
    if (sched) {
      if (sched.title && !resolved.names.includes(sched.title)) resolved.names.push(sched.title);
      if (sched.enTitle && !resolved.names.includes(sched.enTitle)) resolved.names.push(sched.enTitle);
    }
  } else if (fullId.startsWith('anilist:')) {
    const alId = parseInt(fullId.split(':')[1]);
    resolved.anilistId = alId;
    const rec = offlineDB.byAniList.get(alId);
    if (rec) {
      resolved.anidbId = rec.anidb || null;
      resolved.tvdbId = rec.tvdb || null;
      resolved.malId = rec.mal || null;
      resolved.kitsuId = rec.kitsu || null;
      resolved.title = rec.title || null;
      if (rec.title) resolved.names.push(rec.title);
    }
  } else if (fullId.startsWith('kitsu:')) {
    const kitsuId = parseInt(fullId.split(':')[1]);
    resolved.kitsuId = kitsuId;
    const rec = offlineDB.byKitsu.get(kitsuId);
    if (rec) {
      resolved.anidbId = rec.anidb || null;
      resolved.anilistId = rec.anilist || null;
      resolved.tvdbId = rec.tvdb || null;
      resolved.malId = rec.mal || null;
      resolved.title = rec.title || null;
      if (rec.title) resolved.names.push(rec.title);
    }
  } else if (fullId.startsWith('mal:')) {
    const malId = parseInt(fullId.split(':')[1]);
    resolved.malId = malId;
    const rec = offlineDB.byMAL.get(malId);
    if (rec) {
      resolved.anidbId = rec.anidb || null;
      resolved.anilistId = rec.anilist || null;
      resolved.tvdbId = rec.tvdb || null;
      resolved.kitsuId = rec.kitsu || null;
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
        resolved.malId = rec.mal || null;
        resolved.kitsuId = rec.kitsu || null;
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
        resolved.malId = rec.mal || null;
        resolved.kitsuId = rec.kitsu || null;
        resolved.title = rec.title || null;
        if (rec.title) resolved.names.push(rec.title);
        break;
      }
    }
    // Fallback: todayAnimeCache
    if (!resolved.anilistId) {
      for (const s of todayAnimeCache) {
        const rec = offlineDB.byAniList.get(s.anilistId);
        if (rec?.imdb === imdbBase || s.imdbId === imdbBase) {
          resolved.anilistId = s.anilistId;
          resolved.anidbId = rec?.anidb || null;
          resolved.tvdbId = rec?.tvdb || null;
          resolved.title = rec?.title || null;
          if (rec?.title && !resolved.names.includes(rec.title)) resolved.names.push(rec.title);
          if (s.media?.title?.romaji && !resolved.names.includes(s.title)) resolved.names.push(s.title);
          if (s.media?.title?.english && !resolved.names.includes(s.enTitle)) resolved.names.push(s.enTitle);
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
      const rec = offlineDB.byAniList.get(s.anilistId);
      if (resolved.anilistId && s.anilistId === resolved.anilistId) { isTodayAnime = true; todaySchedule = s; break; }
      if (rec?.imdb && fullId.startsWith(rec.imdb)) { isTodayAnime = true; todaySchedule = s; break; }
    }
    // Add today schedule names to resolved
    if (todaySchedule) {
      if (todaySchedule.title && !resolved.names.includes(todaySchedule.title)) resolved.names.push(todaySchedule.title);
      if (todaySchedule.enTitle && !resolved.names.includes(todaySchedule.enTitle)) resolved.names.push(todaySchedule.enTitle);
    }
  }

  // ===== INDEXER SEARCH (sole source) =====
  // NekoBT, SeaDex, AnimeTosho legacy pipelines removed — all results come from our own indexer now.
  const hasIndexer = user?.indexer_enabled;

  if (!hasIndexer) {
    return res.json({ streams: [{
      name: '⚠️ Indexer disabled',
      title: 'Enable the NimeToDex indexer in your settings.',
      url: BASE_URL,
      behaviorHints: { notWebReady: true }
    }] });
  }

  // Build indexer query
  const params = new URLSearchParams();
  if (fullId.startsWith('tt')) params.set('imdb', fullId.split(':')[0]);
  if (resolved.anilistId) params.set('anilist', resolved.anilistId);
  if (resolved.tvdbId) params.set('tvdb', resolved.tvdbId);
  if (resolved.anidbId) params.set('anidb', resolved.anidbId);
  if (resolved.malId) params.set('mal', resolved.malId);
  if (resolved.kitsuId) params.set('kitsu', resolved.kitsuId);
  if (season != null && !isMovie) params.set('season', season);
  if (episode && !isMovie) params.set('episode', episode);

  const mapResults = (results) => results
    .filter(r => r.magnet || r.infohash)
    .map(r => {
      // Find matching episode file in batch
      let matchedFile = null;
      if (r.batch && r.file_list) {
        try {
          const files = typeof r.file_list === 'string' ? JSON.parse(r.file_list) : r.file_list;
          if (Array.isArray(files)) {
            // Priority 1: Use fileIdx from indexer (multi-AL batch support)
            if (r.fileIdx != null || r.file_index != null) {
              const idx = r.fileIdx != null ? r.fileIdx : r.file_index;
              const file = files.find(f => f.idx === idx);
              if (file) {
                matchedFile = { name: (file.name || '').split('/').pop(), size: file.size, idx: file.idx };
              }
            }
            // Priority 2: Regex match by episode number
            if (!matchedFile && episode) {
              const epPad = String(episode).padStart(2, '0');
              const sPad = String(season || 0).padStart(2, '0');
              const found = files.find(f => {
                const n = (f.name || '').toLowerCase();
                return new RegExp(`s${sPad}e${epPad}|\\be${epPad}\\b|\\b${epPad}v\\d|\\s${epPad}\\s|\\s${epPad}\\.|\\-${epPad}\\b`).test(n);
              });
              if (found) {
                matchedFile = { name: (found.name || '').split('/').pop(), size: found.size, idx: found.idx };
              }
            }
          }
        } catch {}
      }

      return {
        name: r.name || 'Unknown',
        magnet: r.magnet || (r.infohash ? `magnet:?xt=urn:btih:${r.infohash}` : null),
        infohash: (r.infohash || '').toLowerCase() || null,
        seeders: String(r.seeders || 0),
        leechers: String(r.leechers || 0),
        filesize: r.filesize ? formatIndexerFilesize(r.filesize) : '?',
        filesizeBytes: parseInt(r.filesize) || 0,
        source: 'indexer',
        indexer: true,
        indexerSource: r.source || null,  // 'nyaa' | 'tokyotosho' | 'nekobt' | 'seadex'
        indexerId: r.id || null,
        releaseGroup: r.group_name || '',
        resolution: r.resolution || '',
        dualAudio: !!r.dual_audio,
        seadexBest: !!r.seadex_best,
        seadex: r.source === 'seadex',
        batch: !!r.batch,
        videoSource: r.video_source || '',
        codec: r.codec || '',
        audioLangs: r.audio_langs || '',
        subtitleLangs: r.subtitle_langs || '',
        audioCodec: r.audio_codec || '',
        audioChannels: r.audio_channels || '',
        bitDepth: r.bit_depth || null,
        encoding: r.encoding || '',
        multiSubs: !!r.multi_subs,
        fileCount: r.file_count || 0,
        matchedFile: matchedFile,
        fileIdx: matchedFile?.idx != null ? matchedFile.idx : (r.fileIdx != null ? r.fileIdx : null),
      };
    });

  const mapToshoResults = (results) => results
    .filter(r => r.magnet || r.infohash)
    .map(r => ({
      name: r.name || 'Unknown',
      magnet: r.magnet || (r.infohash ? `magnet:?xt=urn:btih:${r.infohash}` : null),
      infohash: r.infohash || null,
      seeders: String(r.seeders || 0),
      leechers: String(r.leechers || 0),
      filesize: r.filesize ? formatIndexerFilesize(r.filesize) : '?',
      filesizeBytes: parseInt(r.filesize) || 0,
      source: 'tosho',
      indexer: true,
      indexerSource: 'animetosho',
      tosho: true,
      releaseGroup: r.group_name || '',
      resolution: r.resolution || '',
      dualAudio: !!r.dual_audio,
      seadexBest: !!r.seadex_best,
      batch: !!r.batch,
      videoSource: r.video_source || '',
      codec: r.codec || '',
      audioLangs: r.audio_langs || '',
      subtitleLangs: r.subtitle_langs || '',
      audioCodec: r.audio_codec || '',
      audioChannels: r.audio_channels || '',
      bitDepth: r.bit_depth || null,
      encoding: r.encoding || '',
      multiSubs: !!r.multi_subs,
      fileCount: r.file_count || 0,
      matchedFile: null,
    }));

  // Run indexer search
  let indexerResults = [];
  if (params.toString()) {
    try {
      const t0 = Date.now();
      console.log(`  📦 Indexer: searching ${params.toString()}`);
      const resp = await axios.get(`${INDEXER_URL}/search?${params.toString()}`, { timeout: 8000 });
      const results = resp.data?.results || [];
      const toshoResults = resp.data?.tosho_results || [];
      const ms = Date.now() - t0;
      console.log(`  📦 Indexer: ${results.length} results + ${toshoResults.length} tosho (${ms}ms, searchedBy: ${resp.data?.searchedBy || '?'})`);

      indexerResults = [...mapResults(results), ...mapToshoResults(toshoResults)];

      // Fallback: try fulltext search if nothing found
      if (!indexerResults.length) {
        let searchName = null;
        try {
          const r2 = await resolveToAniDB(type, fullId);
          if (r2?.title) searchName = r2.title;
        } catch {}
        if (!searchName && fullId.startsWith('tt')) {
          try {
            const cine = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${fullId.split(':')[0]}.json`, { timeout: 5000 });
            if (cine.data?.meta?.name) searchName = cine.data.meta.name;
          } catch {}
        }
        if (searchName) {
          const ft0 = Date.now();
          const fbParams = new URLSearchParams({ q: searchName });
          if (season != null && !isMovie) fbParams.set('season', season);
          if (episode && !isMovie) fbParams.set('episode', episode);
          console.log(`  📦 Indexer fallback: q="${searchName}"`);
          const fbResp = await axios.get(`${INDEXER_URL}/search?${fbParams.toString()}`, { timeout: 8000 });
          const qResults = fbResp.data?.results || [];
          const qTosho = fbResp.data?.tosho_results || [];
          console.log(`  📦 Indexer fallback: ${qResults.length} results + ${qTosho.length} tosho (${Date.now() - ft0}ms)`);
          indexerResults = [...mapResults(qResults), ...mapToshoResults(qTosho)];
        }
      }
    } catch (err) {
      console.log(`  📦 Indexer error: ${err.message}`);
    }
  }

  // No results — show fallback streams
  if (!indexerResults.length) {
    const noResultStreams = [{ name: '❌ Not found', title: `Not found on NimeToDex`, url: 'https://nimetodex.duckdns.org', behaviorHints: { notWebReady: true } }];
    if (userPerms.ondemand !== false) {
      noResultStreams.push({
        name: '🔍 Search',
        title: 'Search on demand\nSearches Nyaa + trackers for new results.\nClose video and reopen episode after ~30s.',
        url: `${BASE_URL}/${token}/ondemand/${type}/${fullId}/video.mp4`,
        behaviorHints: { bingeGroup: 'ondemand', notWebReady: true }
      });
    }
    return res.json({ streams: noResultStreams });
  }

  const p2pEnabled = !!user?.p2p_enabled;
  const hasRD = !p2pEnabled && !!user?.rd_api_key && user?.rd_enabled !== false;
  const hasTB = !!user?.tb_api_key;
  const tbTorrents = !p2pEnabled && hasTB && user.tb_use_torrents;

  // Apply sort + filters (handles excludeResolutions, group/res/lang priority — all toggle-controlled)
  const indexerWithMagnet = indexerResults.filter(t => t.magnet);
  let allResults = sortByGroupPriority(indexerWithMagnet, user || null);
  console.log(`  📦 ${allResults.length} results after sort (${indexerWithMagnet.length} input)`);


  // TorBox cache check — batch all hashes in one request
  let tbCacheMap = {};
  const tbCacheCheck = tbTorrents && user?.tb_cache_check !== false;
  if (tbCacheCheck && allResults.length) {
    const hashes = allResults
      .map(t => (t.infohash || t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1] || '').toLowerCase())
      .filter(h => h && h.length >= 32);
    if (hashes.length) {
      tbCacheMap = await checkTBCached(user.tb_api_key, hashes);
    }
  }

  // Combined priority sort: cachedFirst + dubFirst combine into a 4-bucket priority order.
  // When both toggles are ON: cached+EN > uncached+EN > cached+JP > uncached+JP (EN priority, cache as tie-breaker).
  // When only one is ON: simple 2-bucket partition for that dimension.
  // Inside each bucket the preset sort is applied for consistent ordering.
  const cacheActive = tbCacheCheck && user?.cachedFirst && Object.keys(tbCacheMap).length > 0;
  const dubActive = !!user?.dubFirst;

  if (cacheActive || dubActive) {
    const getHash = t => (t.infohash || t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1] || '').toLowerCase();
    const isCached = t => cacheActive && !!tbCacheMap[getHash(t)];
    const hasEN = (t) => {
      if (!t) return false;
      if (t.dualAudio) return true; // dual = ja + en
      const langs = String(t.audioLangs || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      return langs.includes('en');
    };

    // Higher score = higher priority. EN weight=2, cache weight=1 → EN dominates, cache as tie-breaker.
    const score = t => (dubActive && hasEN(t) ? 2 : 0) + (cacheActive && isCached(t) ? 1 : 0);

    const buckets = { 3: [], 2: [], 1: [], 0: [] };
    for (const t of allResults) buckets[score(t)].push(t);
    allResults = [
      ...sortByGroupPriority(buckets[3], user || null),
      ...sortByGroupPriority(buckets[2], user || null),
      ...sortByGroupPriority(buckets[1], user || null),
      ...sortByGroupPriority(buckets[0], user || null),
    ];

    console.log(`  🎯 priority sort: cached+EN=${buckets[3].length} | EN=${buckets[2].length} | cached=${buckets[1].length} | rest=${buckets[0].length}`);
  }

  const streams = [];
  for (const t of allResults) {
    const name = t.name || '';
    const quality = detectQuality(name);
    const epNum = isMovie ? 0 : episode;

    let title, streamName;

    if (t.indexer) {
      // === Indexer result: custom formatting ===

      // Detect audio tag once — reuse for both line1 marker and streamName
      const audioTag = detectAudioTag(t);

      // Line 1: quality tags (resolution · encoding · bit-depth · audio tag)
      const qualityTags = [];
      if (t.resolution) qualityTags.push(t.resolution);
      if (t.encoding) qualityTags.push(t.encoding);
      if (t.bitDepth) qualityTags.push(`${t.bitDepth}-bit`);
      // Mark Dub/Dual/Multi with ✅ (= audio includes English or multi-track)
      if (audioTag) {
        const showCheck = audioTag === 'Dub' || audioTag === 'Dual' || audioTag === 'Multi';
        qualityTags.push(showCheck ? `${audioTag} ✅` : audioTag);
      }
      const line1 = qualityTags.filter(Boolean).join(' · ');

      // Body line: torrent name OR matched batch file
      let bodyLine;
      if (t.batch && t.matchedFile) {
        const fName = t.matchedFile.name.replace(/\.mkv$|\.mp4$/i, '');
        const fSize = t.matchedFile.size ? formatIndexerFilesize(t.matchedFile.size) : '';
        bodyLine = `📂 ${fName}${fSize ? ' (' + fSize + ')' : ''}`;
      } else {
        bodyLine = name;
      }

      // Audio line: 🔊 flags · codec channels
      // Apply per-user language filter if enabled
      const langFilter = user?.langFilterEnabled && Array.isArray(user?.langFilterCodes) && user.langFilterCodes.length
        ? user.langFilterCodes
        : null;
      const audioLineParts = [];
      const audioFlags = langToFlags(t.audioLangs, ['en', 'cs'], langFilter);
      if (audioFlags) audioLineParts.push(`🔊 ${audioFlags}`);
      if (t.audioCodec) {
        const ac = t.audioChannels ? `${t.audioCodec} ${t.audioChannels}` : t.audioCodec;
        audioLineParts.push(ac);
      }
      const audioLine = audioLineParts.join(' · ');

      // Subtitle line: 📝 flags
      const subFlags = langToFlags(t.subtitleLangs, ['en', 'cs'], langFilter);
      const subLine = subFlags ? `📝 ${subFlags}` : '';

      // Stats line: 👥 seeders · 💾 size · [SOURCE]
      const statsParts = [];
      statsParts.push(`👥 ${parseInt(t.seeders) || 0}`);
      statsParts.push(formatSizeWithIcon(t));
      const sourceLabel = formatSourceLabel(t.indexerSource, t.seadexBest);
      if (sourceLabel) statsParts.push(sourceLabel);
      const statsLine = statsParts.join(' · ');

      // Combine all lines, skipping empty ones
      // (line1 with resolution/encoding/audioTag intentionally NOT included —
      //  it's already shown in streamName on Stremio's left side, no need to duplicate)
      title = [bodyLine, audioLine, subLine, statsLine]
        .filter(Boolean)
        .join('\n');

      // Build content streamName: "NimeToDex [🏆|📡] QUALITY · AUDIO"
      // (audioTag already detected above for line1)
      const sourceIcon = t.seadexBest ? '🏆 ' : t.tosho ? '📡 ' : '';
      const qualityPart = t.resolution || '';
      const showCheck = audioTag === 'Dub' || audioTag === 'Dual' || audioTag === 'Multi';
      const audioWithMarker = showCheck ? `${audioTag} ✅` : audioTag;
      const audioPart = audioTag ? ` · ${audioWithMarker}` : '';
      streamName = `NimeToDex ${sourceIcon}${qualityPart}${audioPart}`.trim();
    } else {
      // === Non-indexer result: legacy fallback (currently unused, indexer is sole source) ===
      const tags = [];
      if (quality) tags.push(quality);
      if (t.dualAudio) tags.push('Dual Audio');
      const line1 = tags.filter(Boolean).join(' · ');
      const statsLine = `👥 ${parseInt(t.seeders) || 0} | ${formatSizeWithIcon(t)}`;
      title = `${line1 ? line1 + '\n' : ''}${name}\n${statsLine}`;
      const audioTagFb = detectAudioTag(t);
      const audioWithMarker = audioTagFb === 'Dub' || audioTagFb === 'Dual' ? `${audioTagFb} ✅` : audioTagFb;
      const audioPart = audioTagFb ? ` · ${audioWithMarker}` : '';
      streamName = `NimeToDex ${quality || ''}${audioPart}`.trim();
    }

    // Check TB cache status for this torrent
    const torrentHash = (t.infohash || t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1] || '').toLowerCase();
    const isTBCached = tbCacheMap[torrentHash];

    // Build bingeGroup that's stable across episodes within the same release.
    // Strict match: release group + resolution + dual-audio flag, scoped per season.
    // This way SubsPlease 1080p S1E1 and SubsPlease 1080p S1E2 share a bingeGroup,
    // letting Stremio auto-pick the same release for the next episode.
    // Fallback when no releaseGroup is known: use indexerId so batches still work
    // (a batch torrent has the same indexerId across all its episodes).
    const seasonKey = season ?? 1;
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const grp = norm(t.releaseGroup);
    const res = norm(t.resolution);
    const dual = t.dualAudio ? 'dual' : 'single';
    const releaseSig = grp ? `g-${grp}-${res || 'noRes'}-${dual}` : (t.indexerId ? `id-${t.indexerId}` : null);
    const buildBinge = (suffix) => {
      if (releaseSig) return `nimetodex-${releaseSig}-s${seasonKey}${suffix}`;
      // Last-resort static bingeGroups for non-indexer sources
      if (t.seadex) return `seadex${suffix}`;
      if (t.nekobt) return `neko${suffix}`;
      return `nyaa${suffix}`;
    };

    if (p2pEnabled) {
      // P2P direct playback via Stremio's built-in torrent client.
      // NOTE: this requires Stremio's local streaming server to be running.
      //       - Desktop (Win/Mac/Linux) and Android have it built-in -> works.
      //       - Web (browser) requires Stremio Service companion app on same machine.
      //       - iOS / Apple TV / Stremio Lite do NOT have it -> P2P will NOT work there.
      const ih = torrentHash;
      if (ih && /^[0-9a-f]{40}$/i.test(ih)) {
        const bingeGroup = buildBinge('-p2p');
        const p2pStream = {
          name: `[P2P]\n${streamName}`,
          title,
          infoHash: ih.toLowerCase(),
          sources: P2P_TRACKERS.map(tr => `tracker:${tr}`),
          behaviorHints: { bingeGroup },
        };
        // fileIdx must be a number per Stremio spec
        const fIdx = t.fileIdx != null ? parseInt(t.fileIdx, 10) : NaN;
        if (Number.isFinite(fIdx) && fIdx >= 0) p2pStream.fileIdx = fIdx;
        if (t.matchedFile) {
          if (t.matchedFile.size) p2pStream.behaviorHints.videoSize = t.matchedFile.size;
          if (t.matchedFile.name) p2pStream.behaviorHints.filename = t.matchedFile.name;
        }
        streams.push(p2pStream);
      }
    } else {
      if (hasRD) {
        const bingeGroup = buildBinge('-rd');
        const playEp = t.fileIdx != null ? `fi${t.fileIdx}` : String(epNum);
        const rdStream = { name: `[RD]\n${streamName}`, title,
          url: `${BASE_URL}/${token}/play/${storeMagnet(t.magnet)}/${playEp}/video.mp4`,
          behaviorHints: { bingeGroup, notWebReady: true } };
        if (t.matchedFile) {
          if (t.matchedFile.size) rdStream.behaviorHints.videoSize = t.matchedFile.size;
          if (t.matchedFile.name) rdStream.behaviorHints.filename = t.matchedFile.name;
        }
        streams.push(rdStream);
      }
      if (tbTorrents) {
        const cacheIcon = tbCacheCheck ? (isTBCached ? ' ⚡' : ' ⏳') : '';
        const tbName = `[TB${cacheIcon}]\n${streamName}`;
        // Cache state already shown in name as [TB ⚡] / [TB ⏳], no need to duplicate in title
        const tbTitle = title;
        const bingeGroup = buildBinge('-tb');
        const playEp = t.fileIdx != null ? `fi${t.fileIdx}` : String(epNum);
        const tbStream = { name: tbName, title: tbTitle,
          url: `${BASE_URL}/${token}/play-tb/${storeMagnet(t.magnet)}/${playEp}/video.mp4`,
          behaviorHints: { bingeGroup, notWebReady: true } };
        if (t.matchedFile) {
          if (t.matchedFile.size) tbStream.behaviorHints.videoSize = t.matchedFile.size;
          if (t.matchedFile.name) tbStream.behaviorHints.filename = t.matchedFile.name;
        }
        streams.push(tbStream);
      }
      if (!hasRD && !tbTorrents) {
        streams.push({ name: `[Magnet]\n${streamName}`, title, url: t.magnet, behaviorHints: { notWebReady: true } });
      }
    }
  }

  // Add "Search on demand" as last stream (only if permitted)
  if (hasIndexer && userPerms.ondemand !== false) {
    streams.push({
      name: '🔍 Search',
      title: 'Search on demand\nSearches Nyaa + trackers for new results.\nClose video and reopen episode after ~30s.',
      url: `${BASE_URL}/${token}/ondemand/${type}/${fullId}/video.mp4`,
      behaviorHints: { bingeGroup: 'ondemand', notWebReady: true }
    });
  }

  console.log(`  📤 Streams: ${streams.length} (Indexer)`);
  res.json({ streams });
});

// ===== STREMIO: NIMETODEX NZB ADDON =====
app.get('/:token/nzb/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nzb.search.v2',
    version: '2.2.0',
    name: 'NimeToDex NZB',
    description: 'Anime NZB from NimeToDex indexer — Usenet streaming via TorBox.',
    logo: `${BASE_URL}/logo-nzb.png`,
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['at:', 'kitsu:', 'tt', 'tvdb:', 'anilist:', 'mal:'],
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});

// ===== Language score helper for NZB sorting =====
// Returns lowest index from langOrder found in item's language/subs/title
// Lower = better match. Items with no match get langOrder.length (worst)
// ===== Detect audio language tag for stream name =====
// Priority:
//   1. Explicit indexer audio_langs metadata (highest confidence):
//      - 3+ langs               → Multi
//      - EN present (with/out others) → Dub
//      - JP only                → JP
//   2. Fallback to dual_audio flag (from filename parsing): → Dual
//   3. Unknown → null (no tag)
function detectAudioTag(t) {
  const langs = String(t.audioLangs || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const hasJa = langs.includes('ja');
  const hasEn = langs.includes('en');
  const hasMulti = langs.includes('multi');

  // Priority 1: explicit metadata from indexer
  if (langs.length >= 3 || hasMulti) return 'Multi';
  if (hasEn) return 'Dub';            // EN present (alone or with JP) → Dub
  if (hasJa && langs.length === 1) return 'JP';  // only JP

  // Priority 2: fallback to filename-parsed dual_audio (when audio_langs missing)
  if (t.dualAudio) return 'Dual';

  return null;
}

// ===== Format filesize with icon =====
// Single file (movie / single ep):  💾 1.2 GB
// Batch with episode picked:        💾 956 MB / 📦 1.2 GB
// Batch without episode size:       📦 1.2 GB
function formatSizeWithIcon(t) {
  const isBatch = t.batch === true || (t.matchedFile != null) || (t.fileCount > 1);
  if (isBatch) {
    if (t.matchedFile?.size && t.filesizeBytes) {
      return `💾 ${formatIndexerFilesize(t.matchedFile.size)} / 📦 ${formatIndexerFilesize(t.filesizeBytes)}`;
    }
    return `📦 ${t.filesize || '?'}`;
  }
  return `💾 ${t.filesize || '?'}`;
}

// ===== Format source label =====
// Maps indexer source field to user-facing label like [⭐ SEADEX], [🐱 NYAA], [📺 TOSHO], [🐾 NEKOBT]
// Returns null if source is unknown / missing → no label rendered.
// SeaDex: only show label when seadex_best=1 (best releases only).
function formatSourceLabel(indexerSource, seadexBest) {
  if (!indexerSource) return null;
  switch (indexerSource) {
    case 'seadex':      return seadexBest ? '⭐ SeaDex' : null;
    case 'nyaa':        return '🐱 Nyaa';
    case 'tokyotosho':  return '📺 Tokyotosho';
    case 'animetosho':  return '📡 AT';
    case 'nekobt':      return '🐾 nekoBT';
    default:            return null;
  }
}

// ===== Format filesize from indexer (bytes → human readable) =====
function formatIndexerFilesize(bytes) {
  if (!bytes) return '?';
  const n = parseInt(bytes);
  if (isNaN(n)) return '?';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

const LANG_FLAGS = {
  ja: '🇯🇵', jp: '🇯🇵', japanese: '🇯🇵',
  en: '🇬🇧', eng: '🇬🇧', english: '🇬🇧',
  cs: '🇨🇿', cz: '🇨🇿', czech: '🇨🇿',
  de: '🇩🇪', ger: '🇩🇪', german: '🇩🇪',
  fr: '🇫🇷', fre: '🇫🇷', french: '🇫🇷',
  es: '🇪🇸', spa: '🇪🇸', spanish: '🇪🇸',
  pt: '🇧🇷', por: '🇧🇷', portuguese: '🇧🇷',
  it: '🇮🇹', ita: '🇮🇹', italian: '🇮🇹',
  ko: '🇰🇷', kor: '🇰🇷', korean: '🇰🇷',
  zh: '🇨🇳', chi: '🇨🇳', chinese: '🇨🇳',
  ru: '🇷🇺', rus: '🇷🇺', russian: '🇷🇺',
  ar: '🇸🇦', ara: '🇸🇦', arabic: '🇸🇦',
  pl: '🇵🇱', pol: '🇵🇱', polish: '🇵🇱',
  nl: '🇳🇱', dut: '🇳🇱', dutch: '🇳🇱',
  sv: '🇸🇪', swe: '🇸🇪', swedish: '🇸🇪',
  no: '🇳🇴', nor: '🇳🇴', norwegian: '🇳🇴',
  da: '🇩🇰', dan: '🇩🇰', danish: '🇩🇰',
  fi: '🇫🇮', fin: '🇫🇮', finnish: '🇫🇮',
  hu: '🇭🇺', hun: '🇭🇺', hungarian: '🇭🇺',
  ro: '🇷🇴', rum: '🇷🇴', romanian: '🇷🇴',
  th: '🇹🇭', tha: '🇹🇭', thai: '🇹🇭',
  vi: '🇻🇳', vie: '🇻🇳', vietnamese: '🇻🇳',
  id: '🇮🇩', ind: '🇮🇩', indonesian: '🇮🇩',
  ms: '🇲🇾', may: '🇲🇾', malay: '🇲🇾',
  tr: '🇹🇷', tur: '🇹🇷', turkish: '🇹🇷',
  hi: '🇮🇳', hin: '🇮🇳', hindi: '🇮🇳',
  he: '🇮🇱', heb: '🇮🇱', hebrew: '🇮🇱',
  el: '🇬🇷', gre: '🇬🇷', greek: '🇬🇷',
  uk: '🇺🇦', ukr: '🇺🇦', ukrainian: '🇺🇦',
  bg: '🇧🇬', bul: '🇧🇬', bulgarian: '🇧🇬',
  hr: '🇭🇷', hrv: '🇭🇷', croatian: '🇭🇷',
  sk: '🇸🇰', slo: '🇸🇰', slovak: '🇸🇰',
  sr: '🇷🇸', srp: '🇷🇸', serbian: '🇷🇸',
};

function langToFlags(langStr, prioritize = ['en', 'cs'], filter = null) {
  if (!langStr) return '';
  let codes = langStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // Apply filter if defined (array of allowed lang codes)
  if (Array.isArray(filter) && filter.length) {
    const allowed = new Set(filter.map(c => String(c).toLowerCase()));
    codes = codes.filter(c => allowed.has(c));
  }
  if (!codes.length) return '';
  // Move priority langs to front (EN, CS by default)
  const front = prioritize.filter(p => codes.includes(p));
  const rest = codes.filter(c => !front.includes(c));
  const ordered = [...front, ...rest];
  return ordered.map(c => LANG_FLAGS[c] || c.toUpperCase()).join(' ');
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
  const nzbAccount = config.getAccountByToken(token);
  const nzbPerms = nzbAccount?.permissions || {};
  const isMovie = type === 'movie';

  // NZB addon requires TorBox with NZB enabled
  if (!user?.tb_api_key || !user?.tb_use_nzb) {
    return res.json({ streams: [] });
  }

  // P2P mode disables NZB entirely (only torrents are played P2P, NZB is incompatible)
  if (user.p2p_enabled) {
    console.log(`  📰 NZB skipped: P2P mode is enabled`);
    return res.json({ streams: [] });
  }

  console.log(`=== NZB STREAM === type=${type} id=${fullId}`);

  let { season, episode } = parseEpisodeAndSeason(fullId);
  const idParts = fullId.split(':');

  // Parse at: IDs
  if (fullId.startsWith('at:')) {
    const parts = fullId.split(':');
    if (parts.length >= 4) {
      const sN = parseInt(parts[2]); season = Number.isFinite(sN) ? sN : 1;
      episode = parseInt(parts[3]) || 1;
    }
    else { season = 1; episode = parseInt(parts[2]) || 1; }
  }

  // Resolve IMDb for indexer query
  let imdbId = null;
  let anilistId = null;
  let anidbId = null;
  let tvdbId = null;
  let malId = null;
  let kitsuId = null;

  if (fullId.startsWith('tt')) {
    imdbId = idParts[0];
  } else if (fullId.startsWith('at:') || fullId.startsWith('anilist:')) {
    const alId = parseInt(idParts[1]);
    anilistId = alId;
    const rec = offlineDB.byAniList.get(alId);
    if (rec) {
      anidbId = rec.anidb;
      tvdbId = rec.tvdb;
      malId = rec.mal;
      kitsuId = rec.kitsu;
      if (rec.imdb) imdbId = rec.imdb;
    }
  } else if (fullId.startsWith('kitsu:')) {
    kitsuId = parseInt(idParts[1]);
    const rec = offlineDB.byKitsu.get(kitsuId);
    if (rec) {
      anilistId = rec.anilist;
      anidbId = rec.anidb;
      tvdbId = rec.tvdb;
      malId = rec.mal;
      if (rec.imdb) imdbId = rec.imdb;
    }
  } else if (fullId.startsWith('mal:')) {
    malId = parseInt(idParts[1]);
    const rec = offlineDB.byMAL.get(malId);
    if (rec) {
      anilistId = rec.anilist;
      anidbId = rec.anidb;
      tvdbId = rec.tvdb;
      kitsuId = rec.kitsu;
      if (rec.imdb) imdbId = rec.imdb;
    }
  } else if (fullId.startsWith('tvdb:')) {
    tvdbId = idParts[1];
    const tvdbResolved = resolveViaTVDB(tvdbId, season, episode);
    if (tvdbResolved?.anidbId) {
      anidbId = tvdbResolved.anidbId;
      const rec = offlineDB.byAniDB.get(tvdbResolved.anidbId);
      if (rec) {
        anilistId = rec.anilist;
        malId = rec.mal;
        kitsuId = rec.kitsu;
        if (rec.imdb) imdbId = rec.imdb;
      }
    }
  }

  // Build indexer search params
  const params = new URLSearchParams();
  if (imdbId) params.set('imdb', imdbId);
  if (anilistId) params.set('anilist', anilistId);
  if (anidbId) params.set('anidb', anidbId);
  if (tvdbId) params.set('tvdb', tvdbId);
  if (malId) params.set('mal', malId);
  if (kitsuId) params.set('kitsu', kitsuId);
  if (season != null && !isMovie) params.set('season', season);
  if (episode && !isMovie) params.set('episode', episode);

  console.log(`  📰 NZB: searching indexer ${params.toString()}`);

  let nzbResults = [];
  let toshoNzbResults = [];
  try {
    const resp = await axios.get(`${INDEXER_URL}/search?${params.toString()}`, { timeout: 8000 });
    nzbResults = resp.data?.nzb_results || [];
    // Tosho results that have r2_key = NZB available on R2
    toshoNzbResults = (resp.data?.tosho_results || []).filter(t => t.r2_key);
    console.log(`  📰 NZB: ${nzbResults.length} geek + ${toshoNzbResults.length} tosho from indexer (${resp.data?.searchedBy || '?'})`);
  } catch (err) {
    console.log(`  📰 NZB indexer error: ${err.message}`);
  }

  // Normalize both sources into unified format
  const allNzb = [
    ...nzbResults.map(n => ({
      name: n.title || n.name || 'Unknown',
      size: parseInt(n.size) || n.filesize || 0,
      r2_key: n.r2_key || null,
      source: n.source || 'nzbgeek',
      sourceLabel: '📰 NZBgeek',
    })),
    ...toshoNzbResults.map(t => ({
      name: t.name || 'Unknown',
      size: parseInt(t.filesize) || 0,
      r2_key: t.r2_key || null,
      source: 'animetosho',
      sourceLabel: '📡 AT',
    })),
  ].filter(n => n.r2_key); // Only show NZBs that are on R2

  // Filter and sort NZB results using user preferences (4 preset modes + per-filter toggles)
  let sorted = allNzb;
  let sortMode = user?.sortMode;
  if (!sortMode || sortMode === 'custom') sortMode = 'qualityThenSeeders';

  const resOrder = user?.resPriority || DEFAULT_RESOLUTIONS;
  const getNzbResRank = (t) => {
    const res = detectQuality(t.name);
    if (!res) return resOrder.length;
    const idx = resOrder.indexOf(res);
    return idx >= 0 ? idx : resOrder.length;
  };

  // Pre-filter: exclude resolutions if toggle ON
  if (user?.excludeResEnabled) {
    const excludedRes = new Set((user.excludedResolutions || []).map(r => r.toLowerCase()));
    if (excludedRes.size) {
      sorted = sorted.filter(t => {
        const res = detectQuality(t.name);
        if (res && excludedRes.has(res.toLowerCase())) return false;
        return true;
      });
    }
  }

  // Sort (NZB has no seeders, so all modes effectively use size as secondary)
  if (sortMode === 'qualityThenSeeders' || sortMode === 'qualityThenSize') {
    sorted.sort((a, b) => {
      const r = getNzbResRank(a) - getNzbResRank(b);
      if (r !== 0) return r;
      return (b.size || 0) - (a.size || 0);
    });
  } else if (sortMode === 'seeders' || sortMode === 'size') {
    sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
  }
  const topNzb = sorted.slice(0, 20);

  // Build streams
  const streams = [];
  const epNum = isMovie ? 0 : episode;

  for (const t of topNzb) {
    const quality = detectQuality(t.name);
    const size = t.size ? formatIndexerFilesize(t.size) : '?';

    const tags = [quality, t.sourceLabel, `📦 ${size}`].filter(Boolean);
    const title = `${tags.join(' · ')}\n${t.name}`;

    const nzbUrl = `${R2_NZB_BASE}/${t.r2_key}`;
    streams.push({
      name: `📰 NZB`,
      title,
      url: `${BASE_URL}/${token}/play-nzb/${storeNZB(nzbUrl, t.name)}/${epNum}/video.mp4`,
      behaviorHints: { bingeGroup: 'nzb-indexer', notWebReady: true }
    });
  }

  // Add "Refresh NZB" at the bottom (only if permitted)
  if (imdbId && nzbPerms.ondemand !== false) {
    streams.push({
      name: '🔍 NZB',
      title: 'Refresh NZB\nSearches NZBGeek for new NZB files.\nClose video and reopen episode after ~30s.',
      url: `${BASE_URL}/${token}/nzb-refresh/${imdbId}/${season || 0}/${episode || 0}/video.mp4`,
      behaviorHints: { bingeGroup: 'nzb-refresh', notWebReady: true }
    });
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
  config.loadAccounts();

  // Load ID mapping databases
  await loadOfflineDB();
  await loadAnimeLists();
  await loadMappingCache();

  const users = config.listUsers();
  console.log(`  TMDB: ${config.getTMDBKey() ? '✅' : '❌ (web)'}`);
  console.log(`  Users: ${users.length}`);
  updateCache().catch(err => console.error('❌ Initial cache:', err.message));
  todayAdded.refreshTodayAdded().catch(err => console.error('❌ today-added pre-warm:', err.message));
  // startRssFetcher(); // disabled — using indexer instead
});

// Weekly update of anime-offline-database (Sundays at 5:00)
cron.schedule('0 5 * * 0', () => { weeklyUpdate().catch(e => console.error('Weekly update error:', e.message)); });
