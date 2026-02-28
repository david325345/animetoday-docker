const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');

const PORT = process.env.PORT || 7000;
const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

console.log('🔑 Environment check:');
console.log('  PORT:', PORT);
console.log('  REALDEBRID_API_KEY:', REALDEBRID_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  TMDB_API_KEY:', TMDB_API_KEY ? '✅ Set' : '❌ Missing');

let todayAnimeCache = [];
let rdStreamCache = new Map();

const manifest = {
  id: 'cz.anime.nyaa.rd',
  version: '2.0.0',
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

async function getRealDebridStream(magnet, apiKey) {
  if (!apiKey) return null;
  
  // Lokální cache (1 hodina)
  const cached = rdStreamCache.get(magnet);
  if (cached && (Date.now() - cached.timestamp < 3600000)) {
    console.log('RD: ✅ Cached URL');
    return cached.url;
  }
  
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const postHeaders = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  
  try {
    // 1. Přidat magnet
    console.log('RD: Adding magnet...');
    const add = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { headers: postHeaders, timeout: 15000 }
    );
    const torrentId = add.data?.id;
    if (!torrentId) {
      console.error('RD: ❌ No torrent ID');
      return null;
    }
    console.log(`RD: Torrent ID: ${torrentId}`);
    
    // 2. Info
    const torrentInfo = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers, timeout: 10000 }
    );
    
    const status = torrentInfo.data?.status;
    const files = torrentInfo.data?.files;
    console.log(`RD: Status: ${status}, Files: ${files?.length || 0}`);
    
    // Pokud linky hned ready
    if (torrentInfo.data?.links?.length > 0) {
      console.log('RD: Links already available!');
      const url = await unrestrictLink(torrentInfo.data.links[0], postHeaders);
      if (url) {
        rdStreamCache.set(magnet, { url, timestamp: Date.now() });
        return url;
      }
    }
    
    if (!files || files.length === 0) {
      console.error('RD: ❌ No files');
      return null;
    }
    
    // 3. Vybrat video
    const targetFile = findBestVideoFile(files);
    console.log(`RD: Selected: ${targetFile.path} (${Math.round((targetFile.bytes || 0) / 1024 / 1024)}MB)`);
    
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${targetFile.id}`,
      { headers: postHeaders, timeout: 10000 }
    );

    // 4. Čekat na linky (max ~30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      const info = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers, timeout: 10000 }
      );
      
      const s = info.data?.status;
      console.log(`RD: Poll ${i + 1}/15 - ${s}`);
      
      // Pokud stahuje (není cached), abort po 3 pokusech
      if (s === 'downloading' && i > 2) {
        console.log('RD: ⚠️ Not cached, skipping');
        try { await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`, { headers }); } catch(e) {}
        return null;
      }
      
      if (['dead', 'error', 'virus', 'magnet_error'].includes(s)) {
        console.error(`RD: ❌ ${s}`);
        return null;
      }
      
      if (info.data?.links?.[0]) {
        console.log('RD: Links ready!');
        const url = await unrestrictLink(info.data.links[0], postHeaders);
        if (url) {
          rdStreamCache.set(magnet, { url, timestamp: Date.now() });
          return url;
        }
      }
    }
    
    console.error('RD: ❌ Timeout');
    return null;
  } catch (err) {
    console.error('RD error:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

async function unrestrictLink(link, postHeaders) {
  try {
    const resp = await axios.post(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      `link=${encodeURIComponent(link)}`,
      { headers: postHeaders, timeout: 10000 }
    );
    if (resp.data?.download) {
      console.log(`RD: ✅ URL ready (${resp.data.filename || '?'})`);
      return resp.data.download;
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
  rdStreamCache.clear();
  console.log('🗑️ RD cache cleared');
  console.log(`✅ Cache: ${todayAnimeCache.length} anime`);
}

cron.schedule('0 4 * * *', updateCache);
updateCache();
console.log('⏰ Cache update: každý den ve 4:00');

// ===== Stremio Handlers =====
builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

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
        poster,
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
  if (!schedule) return { meta: null };
  
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
      poster,
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

// ===== STREAM HANDLER =====
// Vrací přímo RealDebrid download URL do Stremio
// Žádný proxy, žádný redirect - Stremio dostane přímo přehratelný link
builder.defineStreamHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { streams: [] };
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { streams: [] };

  const m = schedule.media;
  const targetEpisode = parseInt(episode);
  
  console.log(`\n🎯 Stream: ${m.title.romaji} Ep ${targetEpisode}`);
  
  let torrents = await searchNyaa(m.title.romaji || m.title.english, targetEpisode);
  if (!torrents.length && m.title.english !== m.title.romaji) {
    torrents = await searchNyaa(m.title.english || m.title.romaji, targetEpisode);
  }
  
  const correctEpisodeTorrents = torrents.filter(t => {
    const name = t.name.toLowerCase();
    const episodePattern = new RegExp(`(?:[-_\\s]|e(?:p(?:isode)?)?\\s*)0*${targetEpisode}(?:[\\s\\-_]|$|\\D)`, 'i');
    return episodePattern.test(name);
  });
  
  if (!correctEpisodeTorrents.length) {
    console.log('❌ No matching torrents');
    return {
      streams: [{
        name: '⏳ Ještě není dostupné',
        title: `Epizoda ${targetEpisode} ještě nebyla nahrána na Nyaa.si\n\nZkuste to za chvíli znovu`,
        url: 'https://nyaa.si',
        behaviorHints: { notWebReady: true }
      }]
    };
  }

  console.log(`✅ ${correctEpisodeTorrents.length} matching torrents`);
  const torrentsWithMagnets = correctEpisodeTorrents.filter(t => t.magnet);
  const streams = [];

  // RealDebrid - zkusit top 3 torrenty, vrátit přímo RD URL
  if (REALDEBRID_API_KEY) {
    const topTorrents = torrentsWithMagnets.slice(0, 3);
    
    for (const t of topTorrents) {
      try {
        console.log(`RD: Trying "${t.name}"...`);
        const rdUrl = await getRealDebridStream(t.magnet, REALDEBRID_API_KEY);
        if (rdUrl) {
          streams.push({
            name: '⚡ RealDebrid',
            title: `🎬 ${t.name}\n👥 ${t.seeders} seeders | 📦 ${t.filesize}`,
            url: rdUrl
          });
          console.log(`RD: ✅ Direct URL for "${t.name}"`);
          // Jeden RD stream stačí, nemusíme čekat na všechny
          break;
        } else {
          console.log(`RD: ❌ Not available for "${t.name}"`);
        }
      } catch (err) {
        console.error(`RD error:`, err.message);
      }
    }
  }

  // Magnet fallbacky
  for (const t of torrentsWithMagnets.slice(0, 10)) {
    streams.push({
      name: 'Nyaa (Magnet)',
      title: `🧲 ${t.name}\n👥 ${t.seeders} seeders | 📦 ${t.filesize}`,
      url: t.magnet,
      behaviorHints: { notWebReady: true }
    });
  }

  console.log(`📺 ${streams.length} streams total`);
  return { streams };
});

// ===== Express Server =====
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}/`);
});
