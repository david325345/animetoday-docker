const axios = require('axios');
const { getTMDBKey } = require('./config');

const SIMKL_CLIENT_ID = process.env.SIMKL_CLIENT_ID || 'c53ed1c455c86fa16737bea80b6cdece891cd1f0ff56aa8cd89efcbe7d40f3b0';
const OMDB_API_KEY = process.env.OMDB_API_KEY || 'd7b8b25f';
const CALENDAR_URL = 'https://data.simkl.in/calendar/anime.json';
const API_BASE = 'https://api.simkl.com';
const POSTER_BASE = 'https://wsrv.nl/?url=https://simkl.in/posters/';
const FANART_BASE = 'https://wsrv.nl/?url=https://simkl.in/fanart/';
const REQUEST_DELAY = 300; // ms between SIMKL API calls

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Fetch calendar (static JSON, no API key needed) =====
async function fetchCalendar() {
  try {
    const resp = await axios.get(CALENDAR_URL, { timeout: 15000 });
    const items = resp.data || [];
    console.log(`📅 SIMKL calendar: ${items.length} entries`);
    return items;
  } catch (err) {
    console.error(`❌ SIMKL calendar error: ${err.message}`);
    return [];
  }
}

// ===== Filter calendar to today + N days (Prague timezone) =====
function filterSchedule(calendar, days = 3) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
  const todayDate = new Date(todayStr + 'T00:00:00');
  const endDate = new Date(todayDate.getTime() + days * 24 * 60 * 60 * 1000);

  return calendar.filter(item => {
    // Convert air date to Prague time for comparison
    const airDate = new Date(item.date);
    const airPragueStr = airDate.toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
    const airPragueDate = new Date(airPragueStr + 'T00:00:00');
    return airPragueDate >= todayDate && airPragueDate < endDate;
  });
}

// ===== Get which day an item airs (0=today, 1=tomorrow, 2=day after) in Prague timezone =====
function getAiringDay(dateStr) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
  const itemPragueStr = new Date(dateStr).toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

  const todayDate = new Date(todayStr);
  const itemDate = new Date(itemPragueStr);
  const diffDays = Math.round((itemDate - todayDate) / (24 * 60 * 60 * 1000));
  return diffDays;
}

// ===== Format day name for separator =====
function getDayLabel(dayOffset) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const dayName = date.toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', weekday: 'long' });
  const dateStr = date.toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric' });
  const capitalDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);

  if (dayOffset === 1) return `Zítra · ${capitalDay} ${dateStr}`;
  if (dayOffset === 2) return `Pozítří · ${capitalDay} ${dateStr}`;
  return `${capitalDay} ${dateStr}`;
}

// ===== Fetch anime detail from SIMKL (all IDs + metadata) =====
async function fetchAnimeDetail(simklId) {
  try {
    const resp = await axios.get(`${API_BASE}/anime/${simklId}`, {
      params: { client_id: SIMKL_CLIENT_ID, extended: 'full' },
      timeout: 10000
    });
    return resp.data || null;
  } catch (err) {
    console.error(`  ❌ SIMKL detail ${simklId}: ${err.message}`);
    return null;
  }
}

// ===== Fetch MAL rating from SIMKL ratings endpoint =====
async function fetchMALRating(simklId) {
  try {
    const resp = await axios.get(`${API_BASE}/ratings/`, {
      params: { simkl: simklId, fields: 'ext', client_id: SIMKL_CLIENT_ID },
      timeout: 10000
    });
    return resp.data?.MAL?.rating || null;
  } catch {
    return null;
  }
}

// ===== Fetch AniList score via GraphQL =====
async function fetchAniListScore(anilistId) {
  if (!anilistId) return null;
  try {
    const query = `query ($id: Int) { Media(id: $id, type: ANIME) { averageScore } }`;
    const resp = await axios.post('https://graphql.anilist.co', {
      query, variables: { id: parseInt(anilistId) }
    }, { timeout: 8000 });
    const score = resp.data?.data?.Media?.averageScore;
    return score ? (score / 10).toFixed(1) : null;
  } catch {
    return null;
  }
}

// ===== Build poster URL from SIMKL poster path =====
function getPosterUrl(posterPath, size = '_m') {
  if (!posterPath) return null;
  return `${POSTER_BASE}${posterPath}${size}.webp`;
}

function getFanartUrl(fanartPath) {
  if (!fanartPath) return null;
  return `${FANART_BASE}${fanartPath}_medium.webp`;
}

// ===== Format airing time to CET/Prague =====
function formatTimeCET(isoDate) {
  return new Date(isoDate).toLocaleTimeString('cs-CZ', {
    timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// ===== Main: fetch full schedule with all metadata =====
async function fetchAnimeSchedule() {
  const t0 = Date.now();
  console.log('🔄 Fetching SIMKL anime schedule...');

  // 1. Get calendar
  const calendar = await fetchCalendar();
  if (!calendar.length) return [];

  // 2. Filter to 3 days (today + 2)
  const filtered = filterSchedule(calendar, 3);
  console.log(`📅 Filtered: ${filtered.length} entries for 3 days`);

  // 3. Deduplicate by simkl_id (same anime can appear multiple days)
  const uniqueIds = [...new Set(filtered.map(item => item.ids.simkl_id))];
  console.log(`📅 Unique anime: ${uniqueIds.length}`);

  // 4. Fetch details + ratings for each unique anime
  const detailCache = new Map();
  const ratingCache = new Map();

  for (const simklId of uniqueIds) {
    // Detail (contains all IDs + MAL rating)
    const detail = await fetchAnimeDetail(simklId);
    if (detail) {
      detailCache.set(simklId, detail);

      // MAL rating from detail response (no extra API call needed)
      const malRating = detail.ratings?.mal?.rating || null;
      if (malRating) ratingCache.set(simklId, malRating);

      // If no IMDB ID, try to find it from prequel in relations
      if (!detail.ids?.imdb && detail.relations?.length) {
        const prequel = detail.relations.find(r => r.relation_type === 'prequel' && r.is_direct);
        if (prequel?.ids?.simkl) {
          console.log(`  🔗 No IMDB for ${detail.title}, checking prequel ${prequel.title} (${prequel.ids.simkl})`);
          await sleep(REQUEST_DELAY);
          const prequelDetail = await fetchAnimeDetail(prequel.ids.simkl);
          if (prequelDetail?.ids?.imdb) {
            detail.ids.imdb = prequelDetail.ids.imdb;
            // Also grab tvdb/tmdb if missing
            if (!detail.ids.tvdb && prequelDetail.ids.tvdb) detail.ids.tvdb = prequelDetail.ids.tvdb;
            if (!detail.ids.tmdb && prequelDetail.ids.tmdb) detail.ids.tmdb = prequelDetail.ids.tmdb;
            console.log(`  🔗 Prequel IMDB: ${prequelDetail.ids.imdb}`);
          }
        }
      }

      // If still no IMDB ID, try OMDb search by title
      if (!detail.ids?.imdb && detail.title) {
        try {
          const omdbResp = await axios.get('https://www.omdbapi.com/', {
            params: { apikey: OMDB_API_KEY, t: detail.en_title || detail.title, type: 'series' },
            timeout: 5000
          });
          const omdb = omdbResp.data;
          if (omdb?.Response === 'True' && omdb?.imdbID) {
            // Validate: must be Animation genre and year must be close
            const isAnimation = (omdb.Genre || '').toLowerCase().includes('animation');
            const omdbYear = parseInt(omdb.Year);
            const detailYear = parseInt(detail.year_start_end) || parseInt(detail.year);
            const yearClose = !omdbYear || !detailYear || Math.abs(omdbYear - detailYear) <= 2;

            if (isAnimation && yearClose) {
              detail.ids.imdb = omdb.imdbID;
              console.log(`  🔗 OMDb fallback: ${detail.title} → ${omdb.imdbID} ✅`);
            } else {
              console.log(`  🔗 OMDb fallback: ${detail.title} → ${omdb.imdbID} ❌ rejected (genre=${omdb.Genre}, year=${omdb.Year})`);
            }
          }
        } catch {}
        await sleep(REQUEST_DELAY);
      }

      // If still no IMDB ID, try TMDB external_ids lookup
      if (!detail.ids?.imdb && detail.ids?.tmdb) {
        const tmdbKey = getTMDBKey();
        if (tmdbKey) {
          try {
            const tmdbId = detail.ids.tmdb;
            const tmdbType = (detail.anime_type === 'movie') ? 'movie' : 'tv';
            const extResp = await axios.get(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids`, {
              params: { api_key: tmdbKey }, timeout: 5000
            });
            const imdbId = extResp.data?.imdb_id;
            if (imdbId && imdbId.startsWith('tt')) {
              detail.ids.imdb = imdbId;
              console.log(`  🔗 TMDB fallback: ${detail.title} → TMDB ${tmdbId} → ${imdbId}`);
            } else {
              console.log(`  🔗 TMDB fallback: ${detail.title} → TMDB ${tmdbId} → no IMDB`);
            }
          } catch (err) {
            console.log(`  🔗 TMDB fallback error for ${detail.title}: ${err.message}`);
          }
          await sleep(REQUEST_DELAY);
        }
      }
    }
    await sleep(REQUEST_DELAY);

    // AniList score
    const anilistId = detail?.ids?.anilist;
    if (anilistId) {
      const alScore = await fetchAniListScore(anilistId);
      if (alScore) {
        ratingCache.set(`al:${simklId}`, alScore);
      }
    }
    await sleep(REQUEST_DELAY);
  }

  console.log(`📅 Details: ${detailCache.size}/${uniqueIds.length}, MAL ratings: ${ratingCache.size}`);

  // 5. Build schedule entries
  const schedules = filtered.map(item => {
    const simklId = item.ids.simkl_id;
    const detail = detailCache.get(simklId);
    const malScore = ratingCache.get(simklId) || null;
    const anilistScore = ratingCache.get(`al:${simklId}`) || null;

    const posterUrl = getPosterUrl(item.poster, '_m');
    const fanartUrl = detail ? getFanartUrl(detail.fanart) : null;
    const ids = detail?.ids || item.ids;
    const dayOffset = getAiringDay(item.date);

    return {
      // Core
      simklId,
      title: item.title,
      enTitle: detail?.en_title || null,
      episode: item.episode?.episode || 1,
      airingAt: item.date,
      dayOffset,
      animeType: item.anime_type,

      // IDs (from detail endpoint — has all)
      imdbId: ids.imdb || null,
      anilistId: ids.anilist ? parseInt(ids.anilist) : null,
      malId: ids.mal ? parseInt(ids.mal) : null,
      tvdbId: ids.tvdb ? parseInt(ids.tvdb) : null,
      tmdbId: ids.tmdb ? parseInt(ids.tmdb) : null,
      kitsuId: ids.kitsu ? parseInt(ids.kitsu) : null,

      // Images
      posterUrl,
      fanartUrl,
      posterPath: item.poster,

      // Metadata
      overview: detail?.overview || '',
      genres: detail?.genres || [],
      totalEpisodes: detail?.total_episodes || null,
      network: detail?.network || '',
      studios: detail?.studios || [],

      // Ratings
      malScore,
      anilistScore,
      simklRating: item.ratings?.simkl?.rating || null,

      // Generated poster (set later by poster generator)
      generatedPoster: null,
    };
  });

  const ms = Date.now() - t0;
  console.log(`✅ SIMKL schedule: ${schedules.length} entries (${(ms / 1000).toFixed(1)}s)`);
  return schedules;
}

module.exports = {
  fetchAnimeSchedule,
  formatTimeCET,
  getDayLabel,
  getPosterUrl,
  getFanartUrl,
  SIMKL_CLIENT_ID,
};
