const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');
const crypto = require('crypto');

const PORT = process.env.PORT || 7000;
const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

console.log('🔑 Environment check:');
console.log('  PORT:', PORT);
console.log('  REALDEBRID_API_KEY:', REALDEBRID_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  TMDB_API_KEY:', TMDB_API_KEY ? '✅ Set' : '❌ Missing');

let todayAnimeCache = [];
let rdStreamCache = new Map(); // Cache pro RD streamy (magnet -> URL)

const manifest = {
  id: 'cz.anime.nyaa.rd',
  version: '1.3.0',
  name: 'Anime Today + Nyaa + RealDebrid',
  description: 'Dnešní anime s Nyaa torrenty přes RealDebrid',
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
    const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: TMDB_API_KEY, query: animeName, first_air_date_year: year },
      timeout: 5000
    });
    return response.data?.results?.[0]?.id || null;
  } catch (err) {
    return null;
  }
}

async function getTMDBImages(tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) return null;
  try {
    const response = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/images`, {
      params: { api_key: TMDB_API_KEY },
      timeout: 5000
    });
    const backdrops = response.data?.backdrops || [];
    const posters = response.data?.posters || [];
    const backdrop = backdrops.find(b => b.iso_639_1 === 'en' || !b.iso_639_1) || backdrops[0];
    const poster = posters.find(p => p.iso_639_1 === 'en' || !p.iso_639_1) || posters[0];
    return {
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null
    };
  } catch (err) {
    return null;
  }
}

// ===== AniList API =====
async function getTodayAnime() {
  const query = `
    query ($weekStart: Int, $weekEnd: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(airingAt_greater: $weekStart, airingAt_lesser: $weekEnd, sort: TIME) {
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
          }
        }
      }
    }
  `;
  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % 86400);
  const dayEnd = dayStart + 86400;
  try {
    const response = await axios.post('https://graphql.anilist.co', {
      query,
      variables: { weekStart: dayStart, weekEnd: dayEnd }
    });
    return response.data?.data?.Page?.airingSchedules || [];
  } catch (error) {
    console.error('AniList error:', error.message);
    return [];
  }
}

// ===== Nyaa API =====
async function searchNyaa(animeName, episode) {
  const cleanName = (name) => name
    .replace(/Season \d+/i, '').replace(/Part \d+/i, '')
    .replace(/2nd Season/i, '').replace(/3rd Season/i, '')
    .replace(/\([^)]*\)/g, '').replace(/:/g, '').trim();
  
  const variants = [
    `${animeName} ${episode}`,
    `${cleanName(animeName)} ${episode}`,
    `${animeName.split(':')[0].trim()} ${episode}`,
    `${animeName.split('-')[0].trim()} ${episode}`,
  ];
  
  const noSpecialChars = animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (noSpecialChars !== animeName) {
    variants.push(`${noSpecialChars} ${episode}`);
  }

  let allTorrents = [];
  const seenHashes = new Set();

  for (const query of variants) {
    try {
      let torrents = [];
      for (let page = 1; page <= 2; page++) {
        const result = await si.searchPage(query, page, { filter: 0, category: '1_2' });
        if (result?.length) torrents = torrents.concat(result);
        else break;
      }
      
      for (const t of torrents) {
        const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/)?.[1];
        if (hash && !seenHashes.has(hash)) {
          seenHashes.add(hash);
          allTorrents.push(t);
        }
      }
      
      if (torrents.length) {
        console.log(`Found ${torrents.length} torrents for "${query}"`);
      }
    } catch (err) {
      console.error(`Nyaa error: ${err.message}`);
    }
  }
  
  if (allTorrents.length) {
    console.log(`Total unique: ${allTorrents.length} torrents`);
    return allTorrents.sort((a, b) => b.seeders - a.seeders);
  }
  return [];
}

// ===== RealDebrid API =====
const RD_HEADERS = (apiKey) => ({ 'Authorization': `Bearer ${apiKey}` });
const RD_POST_HEADERS = (apiKey) => ({ 
  'Authorization': `Bearer ${apiKey}`, 
  'Content-Type': 'application/x-www-form-urlencoded' 
});

// Extrahovat info hash z magnet linku
function getInfoHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]{40})/i) || magnet.match(/btih:([a-zA-Z0-9]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

// Najít největší video soubor
function findBestVideoFile(files) {
  const videoExtensions = ['.mp4', '.mkv', '.avi', '.webm', '.m4v'];
  const videoFiles = files.filter(f => 
    videoExtensions.some(ext => (f.path || f.filename || '').toLowerCase().endsWith(ext))
  );
  if (videoFiles.length > 0) {
    return videoFiles.sort((a, b) => (b.bytes || b.filesize || 0) - (a.bytes || a.filesize || 0))[0];
  }
  return files.sort((a, b) => (b.bytes || b.filesize || 0) - (a.bytes || a.filesize || 0))[0];
}

// Zkontrolovat jestli je torrent v RD cache (instant available)
async function checkRDInstantAvailability(infoHash, apiKey) {
  try {
    const response = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${infoHash}`,
      { headers: RD_HEADERS(apiKey), timeout: 5000 }
    );
    const data = response.data;
    if (data && data[infoHash] && data[infoHash].rd && data[infoHash].rd.length > 0) {
      console.log(`RD: ✅ Torrent ${infoHash.substring(0, 8)}... je v cache (instant)`);
      return true;
    }
    console.log(`RD: ❌ Torrent ${infoHash.substring(0, 8)}... NENÍ v cache`);
    return false;
  } catch (err) {
    console.error('RD instantAvailability error:', err.response?.status, err.message);
    return false; // Při chybě to zkusíme stejně
  }
}

async function getRealDebridStream(magnet, apiKey) {
  if (!apiKey) return null;
  
  // Zkontrolovat lokální cache (platnost 1 hodina)
  const cacheKey = `${magnet}_${apiKey}`;
  const cached = rdStreamCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 3600000)) {
    console.log('RD: ✅ Using local cached stream');
    return cached.url;
  }
  
  try {
    console.log('RD: Adding magnet...');
    
    // 1. Přidat magnet
    const add = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { headers: RD_POST_HEADERS(apiKey), timeout: 15000 }
    );
    const torrentId = add.data?.id;
    if (!torrentId) {
      console.error('RD: ❌ No torrent ID returned');
      return null;
    }
    console.log(`RD: Torrent ID: ${torrentId}`);
    
    // 2. Získat info o souborech
    const torrentInfo = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: RD_HEADERS(apiKey), timeout: 10000 }
    );
    
    const status = torrentInfo.data?.status;
    const files = torrentInfo.data?.files;
    console.log(`RD: Status: ${status}, Files: ${files?.length || 0}`);
    
    // Pokud už jsou linky ready (cached torrent)
    if (torrentInfo.data?.links?.length > 0) {
      console.log('RD: Links already available, unrestricting...');
      const streamUrl = await unrestrictLink(torrentInfo.data.links[0], apiKey);
      if (streamUrl) {
        rdStreamCache.set(cacheKey, { url: streamUrl, timestamp: Date.now() });
        return streamUrl;
      }
    }
    
    if (!files || files.length === 0) {
      console.error('RD: ❌ No files in torrent');
      return null;
    }
    
    // 3. Vybrat největší video soubor
    const targetFile = findBestVideoFile(files);
    const fileIds = String(targetFile.id);
    console.log(`RD: Selected file: ${targetFile.path} (${Math.round((targetFile.bytes || 0) / 1024 / 1024)}MB)`);
    
    // 4. Vybrat soubory
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${fileIds}`,
      { headers: RD_POST_HEADERS(apiKey), timeout: 10000 }
    );

    // 5. Čekat na linky (max 30s pro cached, jinak timeout)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      const info = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: RD_HEADERS(apiKey), timeout: 10000 }
      );
      
      const currentStatus = info.data?.status;
      console.log(`RD: Poll ${i + 1}/15 - Status: ${currentStatus}`);
      
      // Pokud stahuje a nemá linky, nemá cenu čekat (není cached)
      if (currentStatus === 'downloading' && i > 2) {
        console.log('RD: ⚠️ Torrent is downloading (not cached), aborting...');
        // Smazat torrent aby nezabíral slot
        try {
          await axios.delete(
            `https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`,
            { headers: RD_HEADERS(apiKey) }
          );
        } catch (e) {}
        return null;
      }
      
      if (currentStatus === 'dead' || currentStatus === 'error' || currentStatus === 'virus' || currentStatus === 'magnet_error') {
        console.error(`RD: ❌ Torrent failed: ${currentStatus}`);
        return null;
      }
      
      if (info.data?.links?.[0]) {
        console.log('RD: Links ready, unrestricting...');
        const streamUrl = await unrestrictLink(info.data.links[0], apiKey);
        if (streamUrl) {
          rdStreamCache.set(cacheKey, { url: streamUrl, timestamp: Date.now() });
          return streamUrl;
        }
      }
    }
    
    console.error('RD: ❌ Timeout waiting for links');
    return null;
  } catch (err) {
    console.error('RealDebrid error:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

async function unrestrictLink(link, apiKey) {
  try {
    const unrestrict = await axios.post(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      `link=${encodeURIComponent(link)}`,
      { headers: RD_POST_HEADERS(apiKey), timeout: 10000 }
    );
    if (unrestrict.data?.download) {
      console.log(`RD: ✅ Stream URL ready! (${unrestrict.data.filename || 'unknown'})`);
      return unrestrict.data.download;
    }
    return null;
  } catch (err) {
    console.error('RD unrestrict error:', err.response?.status, err.message);
    return null;
  }
}

// ===== Cache Update =====
async function updateCache() {
  console.log('🔄 Updating cache...');
  const schedules = await getTodayAnime();
  todayAnimeCache = schedules;
  
  // Vymazat RealDebrid cache při aktualizaci
  rdStreamCache.clear();
  console.log('🗑️ RealDebrid cache cleared');
  
  console.log(`✅ Cache: ${todayAnimeCache.length} anime`);
}

cron.schedule('0 4 * * *', updateCache);
updateCache();

console.log('⏰ Cache update: každý den ve 4:00');

// ===== Stremio Handlers =====
builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

  // Seřadit podle času vysílání (nejdřív = nahoře)
  const sortedCache = [...todayAnimeCache].sort((a, b) => a.airingAt - b.airingAt);

  return {
    metas: sortedCache.map(s => {
      let poster = s.tmdbImages?.poster || s.media.coverImage.extraLarge || s.media.coverImage.large;
      if (!poster || poster === 'null' || poster === '') {
        poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
      }
      const background = s.media.bannerImage || s.tmdbImages?.backdrop || poster;
      
      return {
        id: `nyaa:${s.media.id}:${s.episode}`,
        type: 'series',
        name: s.media.title.romaji || s.media.title.english || s.media.title.native,
        poster: poster,
        background: background || poster,
        logo: s.media.bannerImage || undefined,
        description: `Epizoda ${s.episode}\n\n${(s.media.description || '').replace(/<[^>]*>/g, '')}`,
        genres: s.media.genres || [],
        releaseInfo: `${s.media.season || ''} ${s.media.seasonYear || ''} - Ep ${s.episode}`.trim(),
        imdbRating: s.media.averageScore ? (s.media.averageScore / 10).toFixed(1) : undefined
      };
    })
  };
});

builder.defineMetaHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { meta: null };
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { meta: null};
  
  const m = schedule.media;
  let poster = schedule.tmdbImages?.poster || m.coverImage.extraLarge || m.coverImage.large;
  if (!poster || poster === 'null' || poster === '') {
    poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
  }
  const background = m.bannerImage || schedule.tmdbImages?.backdrop || poster;
  
  return {
    meta: {
      id: args.id,
      type: 'series',
      name: m.title.romaji || m.title.english || m.title.native,
      poster: poster,
      background: background || poster,
      logo: m.bannerImage || undefined,
      description: (m.description || '').replace(/<[^>]*>/g, ''),
      genres: m.genres || [],
      releaseInfo: `${m.season || ''} ${m.seasonYear || ''} - Epizoda ${schedule.episode}`.trim(),
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
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { streams: [] };

  const m = schedule.media;
  const targetEpisode = parseInt(episode);
  
  let torrents = await searchNyaa(m.title.romaji || m.title.english, targetEpisode);
  if (!torrents.length && m.title.english !== m.title.romaji) {
    torrents = await searchNyaa(m.title.english || m.title.romaji, targetEpisode);
  }
  
  // Zkontrolovat jestli torrenty obsahují správný díl
  const correctEpisodeTorrents = torrents.filter(t => {
    const name = t.name.toLowerCase();
    const episodePattern = new RegExp(`(?:[-_\\s]|e(?:p(?:isode)?)?\\s*)0*${targetEpisode}(?:[\\s\\-_]|$|\\D)`, 'i');
    return episodePattern.test(name);
  });
  
  if (!correctEpisodeTorrents.length) {
    return {
      streams: [{
        name: '⏳ Ještě není dostupné',
        title: `Epizoda ${targetEpisode} ještě nebyla nahrána na Nyaa.si\n\nZkuste to za chvíli znovu`,
        url: 'https://nyaa.si',
        behaviorHints: { notWebReady: true }
      }]
    };
  }

  const rdKey = REALDEBRID_API_KEY;
  const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

  const torrentsWithMagnets = correctEpisodeTorrents.filter(t => t.magnet);

  const streams = torrentsWithMagnets.map(t => {
    if (rdKey) {
      const streamUrl = `${baseUrl}/rd/${encodeURIComponent(t.magnet)}?key=${encodeURIComponent(rdKey)}`;
      return {
        name: 'Nyaa + RD',
        title: `🎬 ${t.name}\n👥 ${t.seeders} seeders | 📦 ${t.filesize}`,
        url: streamUrl,
        behaviorHints: { bingeGroup: 'nyaa-rd' }
      };
    } else {
      return {
        name: 'Nyaa (Magnet)',
        title: `🧲 ${t.name}\n👥 ${t.seeders} seeders | 📦 ${t.filesize}`,
        url: t.magnet,
        behaviorHints: { notWebReady: true }
      };
    }
  });

  return { streams };
});

// ===== Express Server =====
const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ROOT route - naše landing page (PŘED static middleware)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/rd/:magnet', async (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  
  try {
    console.log('RD endpoint: Processing request...');
    const stream = await getRealDebridStream(decodeURIComponent(req.params.magnet), apiKey);
    if (stream) {
      console.log(`RD endpoint: Redirecting to stream`);
      res.redirect(302, stream);
    } else {
      console.log('RD endpoint: No stream available');
      res.status(404).json({ error: 'Stream not available - torrent may not be cached on RealDebrid' });
    }
  } catch (err) {
    console.error('RD endpoint error:', err.message);
    res.status(500).json({ error: 'RealDebrid failed' });
  }
});

// Použít SDK router
const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}/`);
});
