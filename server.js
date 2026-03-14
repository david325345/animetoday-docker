const express = require('express');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');
const axios = require('axios');

const config = require('./lib/config');
const { getTodayAnime } = require('./lib/anilist');
const { loadOfflineDB, loadAnimeLists, loadMappingCache, resolveToAniDB, resolveEpisode, parseEpisodeAndSeason, weeklyUpdate, offlineDB } = require('./lib/idmap');
const { searchByAniDBId, searchByText, detectQuality, sortByGroupPriority } = require('./lib/search');
const { getRDStream, rdInProgress, getCacheKey, serveLoadingVideo, DOWNLOADING_VIDEO_URL } = require('./lib/realdebrid');
const { generateAllPosters, formatTimeCET } = require('./lib/posters');

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

cron.schedule('0 4 * * *', updateCache);
cron.schedule('0 */6 * * *', updateCache);

// ===== Magnet store (for clean RD stream URLs) =====
const magnetStore = new Map();
function storeMagnet(magnet) {
  const hash = crypto.createHash('md5').update(magnet).digest('hex');
  magnetStore.set(hash, magnet);
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

// ===== STREMIO: ANIME TODAY ADDON =====
app.get('/:token/today/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nyaa.anime.today.v5',
    version: '5.0.0',
    name: 'Anime Today',
    description: 'Dnešní anime z AniList + Nyaa.si + RealDebrid',
    logo: `${BASE_URL}/logo.png`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [{ type: 'series', id: 'anime-today', name: 'Dnešní Anime', extra: [{ name: 'skip', isRequired: false }] }],
    idPrefixes: ['nyaa:'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

app.get('/:token/today/catalog/:type/:id.json', (req, res) => {
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
      return {
        id: `nyaa:${m.id}:${s.episode}`, type: 'series',
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

app.get('/:token/today/meta/:type/:id.json', (req, res) => {
  const [prefix, anilistId, episode] = req.params.id.split(':');
  if (prefix !== 'nyaa') return res.json({ meta: null });
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return res.json({ meta: null });

  const m = schedule.media;
  const time = formatTimeCET(schedule.airingAt);
  let poster = schedule.generatedPoster ? `${BASE_URL}${schedule.generatedPoster}` : (schedule.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large);
  if (!poster || poster === 'null') poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';

  res.json({
    meta: {
      id: req.params.id, type: 'series',
      name: m.title.romaji || m.title.english || m.title.native,
      poster, background: m.bannerImage || schedule.tmdbImages?.backdrop || poster,
      description: `Vysílání: ${time} (CET)\nEpizoda ${schedule.episode}\n\n${(m.description || '').replace(/<[^>]*>/g, '')}`,
      genres: m.genres || [],
      releaseInfo: `${time} · ${m.season || ''} ${m.seasonYear || ''} · Ep ${schedule.episode}`.trim(),
      imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1).toString() : undefined,
      videos: [{
        id: req.params.id, title: `Epizoda ${schedule.episode}`,
        episode: schedule.episode, season: 1,
        released: new Date(schedule.airingAt * 1000).toISOString(), thumbnail: poster
      }]
    }
  });
});

app.get('/:token/today/stream/:type/:id.json', async (req, res) => {
  const [prefix, anilistId, episode] = req.params.id.split(':');
  if (prefix !== 'nyaa') return res.json({ streams: [] });
  const user = config.getUser(req.params.token);
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return res.json({ streams: [] });

  const m = schedule.media;
  const ep = parseInt(episode);

  // Try AniDB ID lookup → AnimeTosho by ID
  let torrents = [];
  const anilistNum = parseInt(anilistId);
  const record = offlineDB.byAniList.get(anilistNum);

  if (record?.anidb) {
    console.log(`  🆔 AniList ${anilistNum} → AniDB ${record.anidb} "${record.title}"`);
    torrents = await searchByAniDBId(record.anidb, ep);
  }

  // Fallback: text search
  if (!torrents.length) {
    const names = [m.title.romaji, m.title.english].filter(Boolean);
    console.log(`  🔄 Fallback text search: [${names.join(', ')}] ep${ep}`);
    torrents = await searchByText(names, ep);
  }

  if (!torrents.length) {
    return res.json({ streams: [{ name: '❌ Torrent nenalezen', title: `Epizoda ${ep} nebyla nalezena`, externalUrl: 'https://animetosho.org', behaviorHints: { notWebReady: true } }] });
  }

  const hasRD = !!user?.rd_api_key;
  const withMagnet = torrents.filter(t => t.magnet);
  console.log(`  📤 Streams: ${withMagnet.length}`);
  res.json({
    streams: withMagnet.slice(0, 15).map(t => {
      const quality = detectQuality(t.name);
      const title = `${quality ? quality + ' · ' : ''}${t.name}\n👥 ${parseInt(t.seeders) || 0} seeders · 📦 ${t.filesize || 'N/A'}`;
      if (hasRD) {
        return { name: `AT+RD`, title,
          url: `${BASE_URL}/${req.params.token}/play/${storeMagnet(t.magnet)}/${ep}/video.mp4`,
          behaviorHints: { bingeGroup: 'today-rd', notWebReady: true } };
      }
      return { name: `AT 🧲`, title, url: t.magnet, behaviorHints: { notWebReady: true } };
    })
  });
});

// ===== STREMIO: NYAA SEARCH ADDON =====
app.get('/:token/nyaa/manifest.json', (req, res) => {
  res.json({
    id: 'cz.nyaa.search.v5',
    version: '5.0.0',
    name: 'Nyaa Search',
    description: 'Anime z Nyaa.si + RealDebrid. Funguje s Cinemeta/Kitsu.',
    logo: `${BASE_URL}/logo-nyaa.png`,
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['kitsu:', 'tt'],
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

  const { season, episode } = parseEpisodeAndSeason(fullId);
  let torrents = [];

  // 1. For multi-season: try anime-lists to get per-season AniDB ID + correct episode
  if (season > 1 && !isMovie) {
    const epResult = await resolveEpisode(type, fullId, season, episode);
    if (epResult.anidbId) {
      // anime-lists gave us a season-specific AniDB ID
      console.log(`  🎯 Season-specific AniDB: ${epResult.anidbId} ep${epResult.episode}`);
      torrents = await searchByAniDBId(epResult.anidbId, epResult.episode, false);
    }
  }

  // 2. Base AniDB ID lookup (for S01, movies, or if season-specific failed)
  if (!torrents.length) {
    const resolved = await resolveToAniDB(type, fullId);
    if (resolved?.anidb) {
      const searchEp = isMovie ? null : episode;
      torrents = await searchByAniDBId(resolved.anidb, searchEp, isMovie);

      // If S01 episode search found nothing and season > 1, try absolute episode via Cinemeta offset
      if (!torrents.length && season > 1 && !isMovie) {
        const epResult = await resolveEpisode(type, fullId, season, episode);
        if (epResult.episode !== episode) {
          console.log(`  🔄 Trying absolute ep ${epResult.episode}`);
          torrents = await searchByAniDBId(resolved.anidb, epResult.episode, false);
        }
      }
    }
  }

  // 3. Fallback: text search
  if (!torrents.length) {
    let names = [];
    try {
      const resolved = await resolveToAniDB(type, fullId);
      if (resolved?.title) names.push(resolved.title);
    } catch {}

    if (fullId.startsWith('tt')) {
      try {
        const cine = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${fullId.split(':')[0]}.json`, { timeout: 5000 });
        const cineName = cine.data?.meta?.name;
        if (cineName && !names.includes(cineName)) names.push(cineName);
      } catch {}
    }

    if (names.length) {
      console.log(`  🔄 Fallback text search: [${names.join(', ')}]`);
      torrents = await searchByText(names, isMovie ? null : episode, isMovie);
    }
  }

  if (!torrents.length) {
    return res.json({ streams: [{ name: '❌ Nenalezeno', title: `Nenalezeno na AnimeTosho`, url: 'https://animetosho.org', behaviorHints: { notWebReady: true } }] });
  }

  const hasRD = !!user?.rd_api_key;
  const sorted = sortByGroupPriority(torrents);
  const withMagnet = sorted.filter(t => t.magnet);
  console.log(`  📤 Streams: ${withMagnet.length}`);

  res.json({
    streams: withMagnet.slice(0, 20).map(t => {
      const name = t.name || '';
      const quality = detectQuality(name);
      const title = `${quality ? quality + ' · ' : ''}${name}\n👥 ${parseInt(t.seeders) || 0} seeders | 📦 ${t.filesize || '?'}`;
      const epNum = isMovie ? 0 : episode;
      if (hasRD) {
        return { name: `🎌 AT+RD`, title,
          url: `${BASE_URL}/${token}/play/${storeMagnet(t.magnet)}/${epNum}/video.mp4`,
          behaviorHints: { bingeGroup: 'nyaa-rd', notWebReady: true } };
      }
      return { name: `🧲 AT`, title, url: t.magnet, behaviorHints: { notWebReady: true } };
    })
  });
});

// ===== Health =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', uptime: process.uptime(),
    animeCount: todayAnimeCache.length,
    users: config.listUsers().length,
    offlineDB: offlineDB.loaded ? offlineDB.byAniDB.size : 0
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

  const users = config.listUsers();
  console.log(`  TMDB: ${config.getTMDBKey() ? '✅' : '❌ (web)'}`);
  console.log(`  Users: ${users.length}`);
  updateCache().catch(err => console.error('❌ Initial cache:', err.message));
});

// Weekly update of anime-offline-database (Sundays at 5:00)
cron.schedule('0 5 * * 0', () => { weeklyUpdate().catch(e => console.error('Weekly update error:', e.message)); });
