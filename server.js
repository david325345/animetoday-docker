const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');
const crypto = require('crypto');
const fs = require('fs');

// ===== Configuration =====
const PORT = process.env.PORT || 3002;
const RD_OPEN_SOURCE_CLIENT_ID = 'X245A4XAIBGVM'; // RealDebrid opensource client ID
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Load persisted config (TMDB key)
let TMDB_API_KEY = '';
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  TMDB_API_KEY = cfg.tmdb_api_key || '';
} catch { /* no config yet */ }

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ tmdb_api_key: TMDB_API_KEY }), 'utf8');
  } catch (err) {
    console.error('Config save error:', err.message);
  }
}

console.log('═══════════════════════════════════════════');
console.log('  🎬 Anime Today + Nyaa + RealDebrid v4.0');
console.log('═══════════════════════════════════════════');
console.log(`  PORT: ${PORT}`);
console.log(`  TMDB_API_KEY: ${TMDB_API_KEY ? '✅ Loaded from config' : '❌ Not set (configure via web)'}`);

// ===== State =====
let todayAnimeCache = [];
let rdStreamCache = new Map(); // magnet+key -> {url, timestamp}

// ===== Stremio Manifest =====
const manifest = {
  id: 'cz.anime.nyaa.rd.v4',
  version: '4.0.0',
  name: 'Anime Today + Nyaa + RealDebrid',
  description: 'Dnešní anime z AniList, torrenty z Nyaa.si + Sukebei fallback, streaming přes RealDebrid',
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
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
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
  } catch {
    return null;
  }
}

async function getTMDBImages(tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) return null;
  try {
    const resp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/images`, {
      params: { api_key: TMDB_API_KEY },
      timeout: 5000
    });
    const backdrops = resp.data?.backdrops || [];
    const posters = resp.data?.posters || [];
    const backdrop = backdrops.find(b => !b.iso_639_1 || b.iso_639_1 === 'en') || backdrops[0];
    const poster = posters.find(p => !p.iso_639_1 || p.iso_639_1 === 'en') || posters[0];
    return {
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null
    };
  } catch {
    return null;
  }
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
      query,
      variables: { dayStart, dayEnd }
    }, { timeout: 10000 });

    const schedules = resp.data?.data?.Page?.airingSchedules || [];
    console.log(`📡 AniList: ${schedules.length} anime found for today`);

    // Enrich with TMDB images
    for (const s of schedules) {
      try {
        const name = s.media.title.romaji || s.media.title.english;
        const tmdbId = await searchTMDB(name, s.media.seasonYear);
        if (tmdbId) {
          s.tmdbImages = await getTMDBImages(tmdbId);
        }
      } catch { /* ignore TMDB errors */ }
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
    .replace(/Season\s*\d+/i, '')
    .replace(/Part\s*\d+/i, '')
    .replace(/\d+(st|nd|rd|th)\s*Season/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  // Also try without zero-pad
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
        if (result?.length) {
          torrents = torrents.concat(result);
        } else {
          break;
        }
      }

      for (const t of torrents) {
        const hash = t.magnet?.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
        if (hash && !seenHashes.has(hash)) {
          seenHashes.add(hash);
          allTorrents.push(t);
        }
      }

      if (torrents.length) {
        console.log(`  [${label}] "${query}" → ${torrents.length} results`);
      }
    } catch (err) {
      console.error(`  [${label}] Error for "${query}": ${err.message}`);
    }
  }

  return allTorrents;
}

async function searchNyaa(animeName, episode) {
  const variants = buildSearchVariants(animeName, episode);
  console.log(`🔍 Searching Nyaa for: ${animeName} ep ${episode}`);

  // 1. Search Nyaa.si (anime category 1_2)
  let results = await searchNyaaSite(
    (query, page) => si.searchPage(query, page, { filter: 0, category: '1_2' }),
    variants,
    'Nyaa.si'
  );

  // 2. If nothing found, try Sukebei.nyaa.si as fallback
  if (results.length === 0) {
    console.log('  ⚠️ Nothing on Nyaa.si, trying Sukebei...');
    try {
      // Sukebei uses web scraping with different base URL
      // We'll use direct HTTP scraping since nyaapi's si.config is shared
      results = await searchSukebei(variants);
    } catch (err) {
      console.error('  ❌ Sukebei error:', err.message);
    }
  }

  // 3. If still nothing, try broader search on Nyaa (all anime categories)
  if (results.length === 0) {
    console.log('  ⚠️ Trying broader Nyaa search (all categories)...');
    results = await searchNyaaSite(
      (query, page) => si.searchPage(query, page, { filter: 0, category: '1_0' }),
      variants.slice(0, 3), // Only first 3 variants to avoid rate limiting
      'Nyaa.si-broad'
    );
  }

  if (results.length) {
    console.log(`  ✅ Total unique: ${results.length} torrents`);
    return results.sort((a, b) => (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0));
  }

  console.log('  ❌ No torrents found anywhere');
  return [];
}

// Sukebei fallback via direct scraping
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
      // Parse torrent rows from HTML
      const magnetRegex = /magnet:\?xt=urn:btih:[a-fA-F0-9]+[^"']*/g;
      const magnets = html.match(magnetRegex) || [];
      // Parse names and sizes from table rows
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
            magnet: magnet,
            seeders: seederMatch?.[1] || '0',
            filesize: sizeMatch?.[1] || 'Unknown',
            source: 'sukebei'
          });
        }
        rowIndex++;
      }

      if (allTorrents.length > 0) {
        console.log(`  [Sukebei] "${query}" → ${allTorrents.length} results`);
        break; // Found results, no need to try more variants
      }
    } catch (err) {
      console.error(`  [Sukebei] Error: ${err.message}`);
    }
  }

  return allTorrents;
}

// Filter torrents to correct episode
function filterByEpisode(torrents, targetEpisode) {
  const epNum = parseInt(targetEpisode);
  const epPadded = String(epNum).padStart(2, '0');

  return torrents.filter(t => {
    const name = (t.name || '').toLowerCase();
    // Match patterns like: - 05, E05, EP05, Episode 05, S01E05
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
async function getRealDebridStream(magnet, apiKey) {
  if (!apiKey) return null;

  // Check cache (1 hour TTL)
  const cacheKey = crypto.createHash('md5').update(`${magnet}_${apiKey}`).digest('hex');
  const cached = rdStreamCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 3600000)) {
    console.log('  RD: ✅ Cache hit');
    return cached.url;
  }

  try {
    console.log('  RD: Adding magnet...');

    // Step 1: Add magnet
    const addResp = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    const torrentId = addResp.data?.id;
    if (!torrentId) {
      console.error('  RD: No torrent ID returned');
      return null;
    }

    // Step 2: Get torrent info and select files
    const infoResp = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
    );

    const files = infoResp.data?.files;
    if (!files || files.length === 0) {
      console.error('  RD: No files in torrent');
      return null;
    }

    // Select only video files (filter by extension)
    const videoExts = ['.mkv', '.mp4', '.avi', '.webm', '.flv', '.mov', '.wmv'];
    const videoFiles = files.filter(f =>
      videoExts.some(ext => f.path.toLowerCase().endsWith(ext))
    );

    // Use video files if found, otherwise all files
    const selectedFiles = videoFiles.length > 0 ? videoFiles : files;
    const fileIds = selectedFiles.map(f => f.id).join(',');

    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${fileIds}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    // Step 3: Poll for download link
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      const pollResp = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
      );

      const links = pollResp.data?.links;
      if (links && links.length > 0) {
        // Unrestrict the first link
        const unrestrictResp = await axios.post(
          'https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(links[0])}`,
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000
          }
        );

        const downloadUrl = unrestrictResp.data?.download;
        if (downloadUrl) {
          rdStreamCache.set(cacheKey, { url: downloadUrl, timestamp: Date.now() });
          console.log('  RD: ✅ Stream ready');
          return downloadUrl;
        }
      }

      const status = pollResp.data?.status;
      console.log(`  RD: Waiting... (${status}, attempt ${attempt + 1}/15)`);

      // If torrent errored out, stop polling
      if (['error', 'dead', 'magnet_error'].includes(status)) {
        console.error(`  RD: Torrent failed with status: ${status}`);
        return null;
      }
    }

    console.error('  RD: Timed out waiting for download');
    return null;
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error(`  RD: Error - ${err.response?.status || 'unknown'}: ${errMsg}`);
    return null;
  }
}

// ===== Cache Management =====
async function updateCache() {
  console.log('🔄 Updating anime cache...');
  const startTime = Date.now();

  try {
    const schedules = await getTodayAnime();
    todayAnimeCache = schedules;
    rdStreamCache.clear();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Cache updated: ${todayAnimeCache.length} anime (${elapsed}s)`);
  } catch (err) {
    console.error('❌ Cache update failed:', err.message);
  }
}

// Update daily at 4:00 and also every 6 hours
cron.schedule('0 4 * * *', updateCache);
cron.schedule('0 */6 * * *', () => {
  console.log('🔄 Periodic cache refresh...');
  updateCache();
});

// Initial load
updateCache();

// ===== Stremio Handlers =====
builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

  const sorted = [...todayAnimeCache].sort((a, b) => a.airingAt - b.airingAt);

  return {
    metas: sorted.map(s => {
      const m = s.media;
      let poster = s.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large;
      if (!poster || poster === 'null') {
        poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
      }
      const background = m.bannerImage || s.tmdbImages?.backdrop || poster;

      return {
        id: `nyaa:${m.id}:${s.episode}`,
        type: 'series',
        name: m.title.romaji || m.title.english || m.title.native,
        poster,
        background: background || poster,
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

  const schedule = todayAnimeCache.find(
    s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode)
  );
  if (!schedule) return { meta: null };

  const m = schedule.media;
  let poster = schedule.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large;
  if (!poster || poster === 'null') {
    poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
  }
  const background = m.bannerImage || schedule.tmdbImages?.backdrop || poster;

  return {
    meta: {
      id: args.id,
      type: 'series',
      name: m.title.romaji || m.title.english || m.title.native,
      poster,
      background: background || poster,
      description: (m.description || '').replace(/<[^>]*>/g, ''),
      genres: m.genres || [],
      releaseInfo: `${m.season || ''} ${m.seasonYear || ''} · Epizoda ${schedule.episode}`.trim(),
      imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1).toString() : undefined,
      videos: [{
        id: args.id,
        title: `Epizoda ${schedule.episode}`,
        episode: schedule.episode,
        season: 1,
        released: new Date(schedule.airingAt * 1000).toISOString(),
        thumbnail: poster
      }]
    }
  };
});

builder.defineStreamHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { streams: [] };

  const schedule = todayAnimeCache.find(
    s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode)
  );
  if (!schedule) return { streams: [] };

  const m = schedule.media;
  const targetEp = parseInt(episode);

  // Search with romaji title first
  let torrents = await searchNyaa(m.title.romaji || m.title.english, targetEp);

  // If nothing, try english title
  if (!torrents.length && m.title.english && m.title.english !== m.title.romaji) {
    torrents = await searchNyaa(m.title.english, targetEp);
  }

  // Filter to correct episode
  const correctTorrents = filterByEpisode(torrents, targetEp);

  if (!correctTorrents.length) {
    return {
      streams: [{
        name: '⏳ Zatím nedostupné',
        title: `Epizoda ${targetEp} ještě nebyla nahrána na Nyaa.si / Sukebei\n\nZkuste to za chvíli znovu`,
        externalUrl: 'https://nyaa.si',
        behaviorHints: { notWebReady: true }
      }]
    };
  }

  const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;

  return {
    streams: correctTorrents.filter(t => t.magnet).slice(0, 15).map(t => {
      const source = t.source === 'sukebei' ? ' [Sukebei]' : '';
      const seeders = parseInt(t.seeders) || 0;
      const quality = detectQuality(t.name);

      return {
        name: `Nyaa${source}`,
        title: `${quality ? quality + ' · ' : ''}${t.name}\n👥 ${seeders} seeders · 📦 ${t.filesize || 'N/A'}`,
        url: `${baseUrl}/rd-stream?magnet=${encodeURIComponent(t.magnet)}`,
        behaviorHints: {
          bingeGroup: `nyaa-rd${source}`,
          notWebReady: false
        }
      };
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

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== RealDebrid OAuth Device Flow =====
// Step 1: Get device code
app.get('/api/rd/device-code', async (req, res) => {
  try {
    const resp = await axios.get('https://api.real-debrid.com/oauth/v2/device/code', {
      params: {
        client_id: RD_OPEN_SOURCE_CLIENT_ID,
        new_credentials: 'yes'
      },
      timeout: 10000
    });

    res.json({
      device_code: resp.data.device_code,
      user_code: resp.data.user_code,
      verification_url: resp.data.verification_url,
      interval: resp.data.interval,
      expires_in: resp.data.expires_in
    });
  } catch (err) {
    console.error('RD device code error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nepodařilo se získat kód zařízení' });
  }
});

// Step 2: Poll for credentials (client polls this)
app.get('/api/rd/poll-auth', async (req, res) => {
  const { device_code } = req.query;
  if (!device_code) return res.status(400).json({ error: 'Missing device_code' });

  try {
    const resp = await axios.get('https://api.real-debrid.com/oauth/v2/device/credentials', {
      params: {
        client_id: RD_OPEN_SOURCE_CLIENT_ID,
        code: device_code
      },
      timeout: 10000
    });

    // User authorized - now get access token
    const clientId = resp.data.client_id;
    const clientSecret = resp.data.client_secret;

    const tokenResp = await axios.post(
      'https://api.real-debrid.com/oauth/v2/token',
      `client_id=${clientId}&client_secret=${clientSecret}&code=${device_code}&grant_type=http://oauth.net/grant_type/device/1.0`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );

    res.json({
      status: 'authorized',
      access_token: tokenResp.data.access_token,
      refresh_token: tokenResp.data.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      expires_in: tokenResp.data.expires_in
    });
  } catch (err) {
    // 403 means user hasn't authorized yet
    if (err.response?.status === 403) {
      return res.json({ status: 'pending' });
    }
    console.error('RD poll error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Chyba při ověřování' });
  }
});

// Step 3: Refresh access token
app.post('/api/rd/refresh-token', async (req, res) => {
  const { client_id, client_secret, refresh_token } = req.body;
  if (!client_id || !client_secret || !refresh_token) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  try {
    const resp = await axios.post(
      'https://api.real-debrid.com/oauth/v2/token',
      `client_id=${client_id}&client_secret=${client_secret}&code=${refresh_token}&grant_type=http://oauth.net/grant_type/device/1.0`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );

    res.json({
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token,
      expires_in: resp.data.expires_in
    });
  } catch (err) {
    console.error('RD refresh error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nepodařilo se obnovit token' });
  }
});

// Validate RD API key
app.get('/api/rd/validate', async (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).json({ error: 'Missing key' });

  try {
    const resp = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 10000
    });

    res.json({
      valid: true,
      username: resp.data.username,
      email: resp.data.email,
      premium: resp.data.premium > 0,
      expiration: resp.data.expiration
    });
  } catch (err) {
    res.json({ valid: false, error: err.response?.data?.error || 'Invalid key' });
  }
});

// TMDB API key validation + save
app.get('/api/tmdb/validate', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  try {
    const resp = await axios.get('https://api.themoviedb.org/3/configuration', {
      params: { api_key: key },
      timeout: 5000
    });
    res.json({ valid: true });
  } catch {
    res.json({ valid: false });
  }
});

// Save TMDB key on the server (persisted to config.json)
app.post('/api/tmdb/save', express.json(), async (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  try {
    const resp = await axios.get('https://api.themoviedb.org/3/configuration', {
      params: { api_key: key },
      timeout: 5000
    });
    TMDB_API_KEY = key;
    saveConfig();
    console.log('✅ TMDB API key saved via web');
    // Refresh cache to pick up new images
    updateCache();
    res.json({ valid: true, saved: true });
  } catch {
    res.json({ valid: false });
  }
});

// Get TMDB key status (don't expose the key itself)
app.get('/api/tmdb/status', (req, res) => {
  res.json({ configured: !!TMDB_API_KEY });
});

// RealDebrid stream proxy endpoint
app.get('/rd-stream', async (req, res) => {
  const { magnet, key } = req.query;

  // Key can come from query param or from a cookie/header
  const apiKey = key || req.headers['x-rd-key'];
  if (!apiKey) {
    return res.status(401).json({
      error: 'RealDebrid API klíč není nastaven',
      message: 'Přihlaste se přes RealDebrid na webové stránce addonu'
    });
  }
  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet' });
  }

  const streamUrl = await getRealDebridStream(decodeURIComponent(magnet), apiKey);
  if (streamUrl) {
    res.redirect(streamUrl);
  } else {
    res.status(500).json({ error: 'Nepodařilo se získat stream z RealDebrid' });
  }
});

// API: Get current anime list
app.get('/api/anime', (req, res) => {
  res.json({
    count: todayAnimeCache.length,
    updated: new Date().toISOString(),
    anime: todayAnimeCache.map(s => ({
      id: s.media.id,
      episode: s.episode,
      airingAt: s.airingAt,
      title: s.media.title,
      genres: s.media.genres,
      score: s.media.averageScore,
      poster: s.tmdbImages?.poster || s.media.coverImage?.extraLarge
    }))
  });
});

// API: Force cache refresh
app.post('/api/refresh', async (req, res) => {
  await updateCache();
  res.json({ success: true, count: todayAnimeCache.length });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    animeCount: todayAnimeCache.length,
    cacheSize: rdStreamCache.size
  });
});

// Stremio addon router
const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running: http://localhost:${PORT}/`);
  console.log(`📺 Stremio manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`🌐 Landing page: http://localhost:${PORT}/`);
});
