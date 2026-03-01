const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');
const crypto = require('crypto');
const fs = require('fs');

// Prevent crashes from killing the server
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection:', err?.message || err);
});

// ===== Configuration =====
const PORT = process.env.PORT || 3002;
const RD_OPEN_SOURCE_CLIENT_ID = 'X245A4XAIBGVM';
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Load persisted config
let config = { tmdb_api_key: '', rd_api_key: '', hidden_anime: [] };
try {
  const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config = { ...config, ...saved };
} catch { /* first run */ }

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Config save error:', err.message);
  }
}

let TMDB_API_KEY = config.tmdb_api_key || '';

console.log('═══════════════════════════════════════════');
console.log('  🎬 Anime Today + Nyaa + RealDebrid v4.0');
console.log('═══════════════════════════════════════════');
console.log(`  PORT: ${PORT}`);
console.log(`  TMDB: ${TMDB_API_KEY ? '✅' : '❌ (web)'}`);
console.log(`  RD:   ${config.rd_api_key ? '✅' : '❌ (web)'}`);
console.log(`  Hidden: ${config.hidden_anime.length} anime`);

// ===== State =====
let todayAnimeCache = [];
let rdStreamCache = new Map();

// ===== Stremio Manifest =====
const manifest = {
  id: 'cz.anime.nyaa.rd.v4',
  version: '4.0.0',
  name: 'Anime Today + Nyaa + RealDebrid',
  description: 'Dnešní anime z AniList, torrenty z Nyaa.si + Sukebei, streaming přes RealDebrid',
  logo: 'https://raw.githubusercontent.com/david325345/animetoday/main/public/logo.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  catalogs: [{
    type: 'series',
    id: 'anime-today',
    name: 'Dnešní Anime',
    extra: [{ name: 'skip', isRequired: false }]
  }],
  idPrefixes: ['nyaa:'],
  behaviorHints: { configurable: false, configurationRequired: false }
};

const builder = new addonBuilder(manifest);

// ===== TMDB API =====
async function searchTMDB(animeName, year) {
  if (!TMDB_API_KEY) return null;
  try {
    const resp = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: TMDB_API_KEY, query: animeName, first_air_date_year: year },
      timeout: 5000
    });
    return resp.data?.results?.[0]?.id || null;
  } catch { return null; }
}

async function getTMDBImages(tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) return null;
  try {
    const resp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/images`, {
      params: { api_key: TMDB_API_KEY }, timeout: 5000
    });
    const backdrops = resp.data?.backdrops || [];
    const posters = resp.data?.posters || [];
    const backdrop = backdrops.find(b => !b.iso_639_1 || b.iso_639_1 === 'en') || backdrops[0];
    const poster = posters.find(p => !p.iso_639_1 || p.iso_639_1 === 'en') || posters[0];
    return {
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null
    };
  } catch { return null; }
}

// ===== AniList API =====
async function getTodayAnime() {
  const query = `
    query ($dayStart: Int, $dayEnd: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(airingAt_greater: $dayStart, airingAt_lesser: $dayEnd, sort: TIME) {
          id
          airingAt
          episode
          media {
            id
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            description
            genres
            averageScore
            season
            seasonYear
            popularity
          }
        }
      }
    }
  `;
  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % 86400);
  const dayEnd = dayStart + 86400;

  try {
    const resp = await axios.post('https://graphql.anilist.co', {
      query, variables: { dayStart, dayEnd }
    }, { timeout: 10000 });

    const schedules = resp.data?.data?.Page?.airingSchedules || [];
    console.log(`📡 AniList: ${schedules.length} anime found for today`);

    for (const s of schedules) {
      try {
        const name = s.media.title.romaji || s.media.title.english;
        const tmdbId = await searchTMDB(name, s.media.seasonYear);
        if (tmdbId) s.tmdbImages = await getTMDBImages(tmdbId);
      } catch {}
    }
    return schedules;
  } catch (err) {
    console.error('❌ AniList error:', err.message);
    return [];
  }
}

// ===== Nyaa + Sukebei Search =====
function cleanAnimeName(name) {
  return name
    .replace(/Season\s*\d+/i, '').replace(/Part\s*\d+/i, '')
    .replace(/\d+(st|nd|rd|th)\s*Season/i, '')
    .replace(/\([^)]*\)/g, '').replace(/:/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function buildSearchVariants(animeName, episode) {
  const epStr = String(episode).padStart(2, '0');
  const clean = cleanAnimeName(animeName);
  const firstPart = animeName.split(':')[0].trim();
  const noSpecial = animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const variants = new Set();
  variants.add(`${animeName} ${epStr}`);
  variants.add(`${clean} ${epStr}`);
  if (firstPart !== animeName) variants.add(`${firstPart} ${epStr}`);
  if (noSpecial !== animeName && noSpecial !== clean) variants.add(`${noSpecial} ${epStr}`);
  variants.add(`${animeName} ${episode}`);
  variants.add(`${clean} ${episode}`);
  return [...variants];
}

async function searchNyaaSite(searchFn, variants, label) {
  const allTorrents = [];
  const seenHashes = new Set();

  for (const query of variants) {
    try {
      let torrents = [];
      for (let page = 1; page <= 2; page++) {
        const result = await searchFn(query, page);
        if (result?.length) torrents = torrents.concat(result);
        else break;
      }
      for (const t of torrents) {
        const hash = t.magnet?.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
        if (hash && !seenHashes.has(hash)) {
          seenHashes.add(hash);
          allTorrents.push(t);
        }
      }
      if (torrents.length) console.log(`  [${label}] "${query}" → ${torrents.length} results`);
    } catch (err) {
      console.error(`  [${label}] Error for "${query}": ${err.message}`);
    }
  }
  return allTorrents;
}

async function searchNyaa(animeName, episode) {
  const variants = buildSearchVariants(animeName, episode);
  console.log(`🔍 Searching Nyaa for: ${animeName} ep ${episode}`);

  let results = await searchNyaaSite(
    (query, page) => si.searchPage(query, page, { filter: 0, category: '1_2' }),
    variants, 'Nyaa.si'
  );

  if (results.length === 0) {
    console.log('  ⚠️ Nothing on Nyaa.si, trying Sukebei...');
    try { results = await searchSukebei(variants); } catch (err) {
      console.error('  ❌ Sukebei error:', err.message);
    }
  }

  if (results.length === 0) {
    console.log('  ⚠️ Trying broader Nyaa search...');
    results = await searchNyaaSite(
      (query, page) => si.searchPage(query, page, { filter: 0, category: '1_0' }),
      variants.slice(0, 3), 'Nyaa.si-broad'
    );
  }

  if (results.length) {
    console.log(`  ✅ Total unique: ${results.length} torrents`);
    return results.sort((a, b) => (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0));
  }
  console.log('  ❌ No torrents found');
  return [];
}

async function searchSukebei(variants) {
  const allTorrents = [];
  const seenHashes = new Set();

  for (const query of variants.slice(0, 3)) {
    try {
      const resp = await axios.get('https://sukebei.nyaa.si/', {
        params: { f: 0, c: '0_0', q: query, s: 'seeders', o: 'desc' },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnimeAddon/4.0)' }
      });
      const html = resp.data;
      const magnetRegex = /magnet:\?xt=urn:btih:[a-fA-F0-9]+[^"']*/g;
      const magnets = html.match(magnetRegex) || [];
      const rowRegex = /<tr[^>]*class="(?:default|success|danger)"[^>]*>([\s\S]*?)<\/tr>/g;
      let match;
      let rowIndex = 0;

      while ((match = rowRegex.exec(html)) !== null && rowIndex < magnets.length) {
        const row = match[1];
        const nameMatch = row.match(/<a[^>]*href="\/view\/\d+"[^>]*>([^<]+)<\/a>/);
        const sizeMatch = row.match(/<td[^>]*class="text-center"[^>]*>(\d+[\d.]*\s*[KMGT]iB)<\/td>/);
        const seederMatch = row.match(/<td[^>]*class="text-center"[^>]*style="color:\s*green[^"]*"[^>]*>(\d+)<\/td>/);
        const magnet = magnets[rowIndex];
        const hash = magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();

        if (hash && !seenHashes.has(hash)) {
          seenHashes.add(hash);
          allTorrents.push({
            name: nameMatch?.[1]?.trim() || 'Unknown',
            magnet, seeders: seederMatch?.[1] || '0',
            filesize: sizeMatch?.[1] || 'Unknown', source: 'sukebei'
          });
        }
        rowIndex++;
      }
      if (allTorrents.length > 0) {
        console.log(`  [Sukebei] "${query}" → ${allTorrents.length} results`);
        break;
      }
    } catch (err) {
      console.error(`  [Sukebei] Error: ${err.message}`);
    }
  }
  return allTorrents;
}

function filterByEpisode(torrents, targetEpisode) {
  const epNum = parseInt(targetEpisode);
  const epPadded = String(epNum).padStart(2, '0');

  return torrents.filter(t => {
    const name = (t.name || '');
    const patterns = [
      new RegExp(`[-_\\s]\\s*${epPadded}(?:[\\s\\-_v.]|$)`, 'i'),
      new RegExp(`[-_\\s]\\s*${epNum}(?:[\\s\\-_v.]|$)`, 'i'),
      new RegExp(`e(?:p(?:isode)?)?\\s*${epPadded}(?:[\\s\\-_v.]|$)`, 'i'),
      new RegExp(`e(?:p(?:isode)?)?\\s*${epNum}(?:[\\s\\-_v.]|$)`, 'i'),
      new RegExp(`s\\d+e${epPadded}(?:[\\s\\-_v.]|$)`, 'i'),
    ];
    return patterns.some(p => p.test(name));
  });
}

// ===== RealDebrid API =====
async function getRealDebridStream(magnet) {
  const apiKey = config.rd_api_key;
  if (!apiKey) return null;

  const cacheKey = crypto.createHash('md5').update(magnet).digest('hex');
  const cached = rdStreamCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 3600000)) {
    console.log('  RD: ✅ Cache hit');
    return cached.url;
  }

  try {
    console.log('  RD: Adding magnet...');
    const addResp = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    const torrentId = addResp.data?.id;
    if (!torrentId) { console.error('  RD: No torrent ID'); return null; }

    const infoResp = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
    );
    const files = infoResp.data?.files;
    if (!files?.length) { console.error('  RD: No files'); return null; }

    const videoExts = ['.mkv', '.mp4', '.avi', '.webm', '.flv', '.mov', '.wmv'];
    const videoFiles = files.filter(f => videoExts.some(ext => f.path.toLowerCase().endsWith(ext)));
    const selected = videoFiles.length > 0 ? videoFiles : files;
    const fileIds = selected.map(f => f.id).join(',');

    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${fileIds}`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollResp = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
      );
      const links = pollResp.data?.links;
      if (links?.length) {
        const unResp = await axios.post(
          'https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(links[0])}`,
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        const downloadUrl = unResp.data?.download;
        if (downloadUrl) {
          rdStreamCache.set(cacheKey, { url: downloadUrl, timestamp: Date.now() });
          console.log('  RD: ✅ Stream ready');
          return downloadUrl;
        }
      }
      const status = pollResp.data?.status;
      console.log(`  RD: Waiting... (${status}, ${attempt + 1}/15)`);
      if (['error', 'dead', 'magnet_error'].includes(status)) {
        console.error(`  RD: Failed: ${status}`);
        return null;
      }
    }
    console.error('  RD: Timed out');
    return null;
  } catch (err) {
    console.error(`  RD: Error - ${err.response?.status || '?'}: ${err.response?.data?.error || err.message}`);
    return null;
  }
}

// ===== Cache =====
async function updateCache() {
  console.log('🔄 Updating anime cache...');
  const t0 = Date.now();
  try {
    const schedules = await getTodayAnime();
    todayAnimeCache = schedules;
    rdStreamCache.clear();
    console.log(`✅ Cache updated: ${todayAnimeCache.length} anime (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.error('❌ Cache update failed:', err.message);
  }
}

cron.schedule('0 4 * * *', updateCache);
cron.schedule('0 */6 * * *', () => { console.log('🔄 Periodic refresh...'); updateCache(); });

// ===== Stremio Handlers =====
// Helper: check if anime is hidden
function isHidden(mediaId) {
  return config.hidden_anime.includes(mediaId);
}

builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

  const sorted = [...todayAnimeCache]
    .filter(s => !isHidden(s.media.id))
    .sort((a, b) => a.airingAt - b.airingAt);

  return {
    metas: sorted.map(s => {
      const m = s.media;
      let poster = s.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large;
      if (!poster || poster === 'null') poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
      const background = m.bannerImage || s.tmdbImages?.backdrop || poster;
      return {
        id: `nyaa:${m.id}:${s.episode}`,
        type: 'series',
        name: m.title.romaji || m.title.english || m.title.native,
        poster, background: background || poster,
        description: `Epizoda ${s.episode}\n\n${(m.description || '').replace(/<[^>]*>/g, '')}`,
        genres: m.genres || [],
        releaseInfo: `${m.season || ''} ${m.seasonYear || ''} · Ep ${s.episode}`.trim(),
        imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined
      };
    })
  };
});

builder.defineMetaHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { meta: null };
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { meta: null };

  const m = schedule.media;
  let poster = schedule.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large;
  if (!poster || poster === 'null') poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
  const background = m.bannerImage || schedule.tmdbImages?.backdrop || poster;

  return {
    meta: {
      id: args.id, type: 'series',
      name: m.title.romaji || m.title.english || m.title.native,
      poster, background: background || poster,
      description: (m.description || '').replace(/<[^>]*>/g, ''),
      genres: m.genres || [],
      releaseInfo: `${m.season || ''} ${m.seasonYear || ''} · Epizoda ${schedule.episode}`.trim(),
      imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1).toString() : undefined,
      videos: [{
        id: args.id, title: `Epizoda ${schedule.episode}`,
        episode: schedule.episode, season: 1,
        released: new Date(schedule.airingAt * 1000).toISOString(),
        thumbnail: poster
      }]
    }
  };
});

builder.defineStreamHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { streams: [] };
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { streams: [] };

  const m = schedule.media;
  const targetEp = parseInt(episode);

  let torrents = await searchNyaa(m.title.romaji || m.title.english, targetEp);
  if (!torrents.length && m.title.english && m.title.english !== m.title.romaji) {
    torrents = await searchNyaa(m.title.english, targetEp);
  }

  const correctTorrents = filterByEpisode(torrents, targetEp);

  if (!correctTorrents.length) {
    return {
      streams: [{
        name: '⏳ Zatím nedostupné',
        title: `Epizoda ${targetEp} ještě nebyla nahrána\n\nZkuste to za chvíli znovu`,
        externalUrl: 'https://nyaa.si',
        behaviorHints: { notWebReady: true }
      }]
    };
  }

  // RD key is on server — no need to pass in URL
  const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  const hasRD = !!config.rd_api_key;

  return {
    streams: correctTorrents.filter(t => t.magnet).slice(0, 15).map(t => {
      const source = t.source === 'sukebei' ? ' [Sukebei]' : '';
      const seeders = parseInt(t.seeders) || 0;
      const quality = detectQuality(t.name);

      if (hasRD) {
        return {
          name: `Nyaa+RD${source}`,
          title: `${quality ? quality + ' · ' : ''}${t.name}\n👥 ${seeders} seeders · 📦 ${t.filesize || 'N/A'}`,
          url: `${baseUrl}/rd-stream/${storeMagnet(t.magnet)}`,
          behaviorHints: { bingeGroup: `nyaa-rd${source}`, notWebReady: false }
        };
      } else {
        return {
          name: `Nyaa${source} (Magnet)`,
          title: `${quality ? quality + ' · ' : ''}${t.name}\n👥 ${seeders} seeders · 📦 ${t.filesize || 'N/A'}`,
          url: t.magnet,
          behaviorHints: { notWebReady: true }
        };
      }
    })
  };
});

function detectQuality(name) {
  const n = name.toLowerCase();
  if (n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return '4K';
  if (n.includes('1080p') || n.includes('fullhd')) return '1080p';
  if (n.includes('720p') || n.includes('hd')) return '720p';
  if (n.includes('480p') || n.includes('sd')) return '480p';
  return '';
}

// ===== Express Server =====
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
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ===== Magnet store for RD stream =====
// We store magnets in memory keyed by md5 hash so the stream URL is clean
const magnetStore = new Map();

// When stream handler creates URLs, it also stores the magnet
function storeMagnet(magnet) {
  const hash = crypto.createHash('md5').update(magnet).digest('hex');
  magnetStore.set(hash, magnet);
  return hash;
}

// RD stream endpoint - magnet is looked up by hash, RD key is on server
app.get('/rd-stream/:hash', async (req, res) => {
  const magnet = magnetStore.get(req.params.hash);
  if (!magnet) {
    return res.status(404).json({ error: 'Magnet not found. Try refreshing the stream list.' });
  }
  if (!config.rd_api_key) {
    return res.status(401).json({ error: 'RealDebrid není nastaven. Přihlaste se na webové stránce addonu.' });
  }
  const streamUrl = await getRealDebridStream(magnet);
  if (streamUrl) {
    res.redirect(streamUrl);
  } else {
    res.status(500).json({ error: 'Nepodařilo se získat stream z RealDebrid' });
  }
});

// Fix: also store magnets when stream handler runs
// Override the stream URL generation to use storeMagnet
// (already done in defineStreamHandler above)

// ===== RealDebrid OAuth Device Flow =====
app.get('/api/rd/device-code', async (req, res) => {
  try {
    const resp = await axios.get('https://api.real-debrid.com/oauth/v2/device/code', {
      params: { client_id: RD_OPEN_SOURCE_CLIENT_ID, new_credentials: 'yes' }, timeout: 10000
    });
    res.json({
      device_code: resp.data.device_code, user_code: resp.data.user_code,
      verification_url: resp.data.verification_url,
      interval: resp.data.interval, expires_in: resp.data.expires_in
    });
  } catch (err) {
    console.error('RD device code error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nepodařilo se získat kód zařízení' });
  }
});

app.get('/api/rd/poll-auth', async (req, res) => {
  const { device_code } = req.query;
  if (!device_code) return res.status(400).json({ error: 'Missing device_code' });

  try {
    const resp = await axios.get('https://api.real-debrid.com/oauth/v2/device/credentials', {
      params: { client_id: RD_OPEN_SOURCE_CLIENT_ID, code: device_code }, timeout: 10000
    });
    const tokenResp = await axios.post(
      'https://api.real-debrid.com/oauth/v2/token',
      `client_id=${resp.data.client_id}&client_secret=${resp.data.client_secret}&code=${device_code}&grant_type=http://oauth.net/grant_type/device/1.0`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    // Save to server config!
    config.rd_api_key = tokenResp.data.access_token;
    config.rd_refresh_token = tokenResp.data.refresh_token;
    config.rd_client_id = resp.data.client_id;
    config.rd_client_secret = resp.data.client_secret;
    saveConfig();
    console.log('✅ RealDebrid connected via OAuth');

    res.json({
      status: 'authorized',
      access_token: tokenResp.data.access_token,
      expires_in: tokenResp.data.expires_in
    });
  } catch (err) {
    if (err.response?.status === 403) return res.json({ status: 'pending' });
    console.error('RD poll error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Chyba při ověřování' });
  }
});

app.post('/api/rd/refresh-token', async (req, res) => {
  if (!config.rd_client_id || !config.rd_client_secret || !config.rd_refresh_token) {
    return res.status(400).json({ error: 'No credentials to refresh' });
  }
  try {
    const resp = await axios.post(
      'https://api.real-debrid.com/oauth/v2/token',
      `client_id=${config.rd_client_id}&client_secret=${config.rd_client_secret}&code=${config.rd_refresh_token}&grant_type=http://oauth.net/grant_type/device/1.0`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    config.rd_api_key = resp.data.access_token;
    config.rd_refresh_token = resp.data.refresh_token;
    saveConfig();
    res.json({ success: true, expires_in: resp.data.expires_in });
  } catch (err) {
    console.error('RD refresh error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nepodařilo se obnovit token' });
  }
});

app.get('/api/rd/status', async (req, res) => {
  if (!config.rd_api_key) return res.json({ connected: false });
  try {
    const resp = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
      headers: { 'Authorization': `Bearer ${config.rd_api_key}` }, timeout: 10000
    });
    res.json({
      connected: true, username: resp.data.username,
      email: resp.data.email, premium: resp.data.premium > 0,
      expiration: resp.data.expiration
    });
  } catch (err) {
    // Try refresh
    if (config.rd_refresh_token) {
      try {
        const refreshResp = await axios.post(
          'https://api.real-debrid.com/oauth/v2/token',
          `client_id=${config.rd_client_id}&client_secret=${config.rd_client_secret}&code=${config.rd_refresh_token}&grant_type=http://oauth.net/grant_type/device/1.0`,
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        config.rd_api_key = refreshResp.data.access_token;
        config.rd_refresh_token = refreshResp.data.refresh_token;
        saveConfig();
        // Retry
        const retryResp = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
          headers: { 'Authorization': `Bearer ${config.rd_api_key}` }, timeout: 10000
        });
        return res.json({
          connected: true, username: retryResp.data.username,
          email: retryResp.data.email, premium: retryResp.data.premium > 0,
          expiration: retryResp.data.expiration
        });
      } catch {}
    }
    res.json({ connected: false });
  }
});

// Save RD key manually
app.post('/api/rd/save-key', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    const resp = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
      headers: { 'Authorization': `Bearer ${key}` }, timeout: 10000
    });
    config.rd_api_key = key;
    config.rd_refresh_token = '';
    config.rd_client_id = '';
    config.rd_client_secret = '';
    saveConfig();
    console.log('✅ RealDebrid API key saved manually');
    res.json({
      success: true, username: resp.data.username,
      premium: resp.data.premium > 0, expiration: resp.data.expiration
    });
  } catch (err) {
    res.json({ success: false, error: err.response?.data?.error || 'Invalid key' });
  }
});

app.post('/api/rd/disconnect', (req, res) => {
  config.rd_api_key = '';
  config.rd_refresh_token = '';
  config.rd_client_id = '';
  config.rd_client_secret = '';
  saveConfig();
  rdStreamCache.clear();
  console.log('🔌 RealDebrid disconnected');
  res.json({ success: true });
});

// ===== TMDB =====
app.post('/api/tmdb/save', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    await axios.get('https://api.themoviedb.org/3/configuration', { params: { api_key: key }, timeout: 5000 });
    TMDB_API_KEY = key;
    config.tmdb_api_key = key;
    saveConfig();
    console.log('✅ TMDB API key saved');
    updateCache();
    res.json({ valid: true, saved: true });
  } catch { res.json({ valid: false }); }
});

app.get('/api/tmdb/status', (req, res) => {
  res.json({ configured: !!TMDB_API_KEY });
});

// ===== Anime filter (hide/show) =====
app.get('/api/anime', (req, res) => {
  res.json({
    count: todayAnimeCache.length,
    hidden: config.hidden_anime,
    anime: todayAnimeCache.map(s => ({
      id: s.media.id,
      episode: s.episode,
      airingAt: s.airingAt,
      title: s.media.title,
      genres: s.media.genres,
      score: s.media.averageScore,
      poster: s.tmdbImages?.poster || s.media.coverImage?.extraLarge,
      hidden: config.hidden_anime.includes(s.media.id)
    }))
  });
});

app.post('/api/anime/hide', (req, res) => {
  const { mediaId } = req.body;
  if (!mediaId) return res.status(400).json({ error: 'Missing mediaId' });
  const id = parseInt(mediaId);
  if (!config.hidden_anime.includes(id)) {
    config.hidden_anime.push(id);
    saveConfig();
    console.log(`👁️ Hidden anime: ${id}`);
  }
  res.json({ success: true, hidden: config.hidden_anime });
});

app.post('/api/anime/show', (req, res) => {
  const { mediaId } = req.body;
  if (!mediaId) return res.status(400).json({ error: 'Missing mediaId' });
  const id = parseInt(mediaId);
  config.hidden_anime = config.hidden_anime.filter(x => x !== id);
  saveConfig();
  console.log(`👁️ Unhidden anime: ${id}`);
  res.json({ success: true, hidden: config.hidden_anime });
});

app.post('/api/refresh', async (req, res) => {
  await updateCache();
  res.json({ success: true, count: todayAnimeCache.length });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), animeCount: todayAnimeCache.length, cacheSize: rdStreamCache.size });
});

// Stremio addon router
const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

// Start server FIRST, then load cache
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running: http://localhost:${PORT}/`);
  console.log(`📺 Stremio manifest: http://localhost:${PORT}/manifest.json`);
  updateCache().catch(err => {
    console.error('❌ Initial cache failed:', err.message);
  });
});
