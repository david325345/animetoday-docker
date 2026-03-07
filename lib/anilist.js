const axios = require('axios');
const { getTMDBKey } = require('./config');

// ===== TMDB =====
async function searchTMDB(animeName, year) {
  const key = getTMDBKey();
  if (!key) return null;
  try {
    const resp = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: key, query: animeName, first_air_date_year: year }, timeout: 5000
    });
    return resp.data?.results?.[0]?.id || null;
  } catch { return null; }
}

async function getTMDBImages(tmdbId) {
  const key = getTMDBKey();
  if (!key || !tmdbId) return null;
  try {
    const resp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/images`, {
      params: { api_key: key }, timeout: 5000
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

// ===== AniList =====
async function getTodayAnime() {
  const query = `
    query ($dayStart: Int, $dayEnd: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(airingAt_greater: $dayStart, airingAt_lesser: $dayEnd, sort: TIME) {
          id airingAt episode
          media {
            id
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage description genres
            averageScore season seasonYear popularity
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

// ===== Name resolvers for Nyaa addon (from Kitsu/IMDb IDs) =====
function isLatinScript(str) {
  return /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF\s\-:!?.'&]+$/.test(str);
}

function isJunkTitle(str) {
  return /mini anime|recap|ova|special|pv|promo|preview|part \d|●|\?\?/i.test(str);
}

function normalizeMacrons(str) {
  const oo = str
    .replace(/[ûú]/gi, m => /[A-Z]/.test(m) ? 'UU' : 'uu')
    .replace(/[ôó]/gi, m => /[A-Z]/.test(m) ? 'OO' : 'oo')
    .replace(/ū/gi, m => /[A-Z]/.test(m) ? 'UU' : 'uu')
    .replace(/ō/gi, m => /[A-Z]/.test(m) ? 'OO' : 'oo')
    .replace(/ā/gi, m => /[A-Z]/.test(m) ? 'AA' : 'aa');
  const ou = str
    .replace(/[ûú]/gi, m => /[A-Z]/.test(m) ? 'UU' : 'uu')
    .replace(/[ôó]/gi, m => /[A-Z]/.test(m) ? 'OU' : 'ou')
    .replace(/ū/gi, m => /[A-Z]/.test(m) ? 'UU' : 'uu')
    .replace(/ō/gi, m => /[A-Z]/.test(m) ? 'OU' : 'ou')
    .replace(/ā/gi, m => /[A-Z]/.test(m) ? 'AA' : 'aa');
  return [oo, ou].filter(v => v !== str);
}

const nameCache = new Map();
const NAME_CACHE_TTL = 24 * 60 * 60 * 1000;

async function getNamesFromKitsu(kitsuId) {
  try {
    const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 8000 });
    const attrs = res.data?.data?.attributes;
    if (!attrs) return { names: [], year: null };
    const names = [attrs.titles?.en_jp, attrs.titles?.en, attrs.canonicalTitle]
      .filter(n => n && isLatinScript(n) && !isJunkTitle(n));
    const year = attrs.startDate ? parseInt(attrs.startDate.substring(0, 4)) : null;
    return { names: [...new Set(names)], year };
  } catch { return { names: [], year: null }; }
}

async function getNamesFromIMDb(type, imdbId) {
  try {
    const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const name = res.data?.meta?.name;
    if (!name) return { names: [], year: null };

    const searchName = normalizeMacrons(name)[1] || normalizeMacrons(name)[0] || name;
    const gql = `
      query ($search: String) {
        Page(page: 1, perPage: 10) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            format title { romaji english native } startDate { year }
          }
        }
      }
    `;
    const aRes = await axios.post('https://graphql.anilist.co', { query: gql, variables: { search: searchName } }, { timeout: 8000 });
    const mediaList = aRes.data?.data?.Page?.media || [];
    if (!mediaList.length) return { names: [], year: null, notAnime: true };

    const nameLower = name.toLowerCase();
    const isSeriesRequest = type === 'series';
    const scored = mediaList.map(m => {
      const titles = [m.title?.romaji, m.title?.english].filter(Boolean);
      const score = titles.reduce((max, t) => {
        const words = nameLower.split(/\s+/).filter(w => w.length > 2);
        const matches = words.filter(w => t.toLowerCase().includes(w)).length;
        return Math.max(max, words.length ? matches / words.length : 0);
      }, 0);
      return { m, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const bestMatch = scored.find(({ m, score }) =>
      score >= 0.5 && (isSeriesRequest ? (m.format === 'TV' || m.format === 'TV_SHORT') : m.format === 'MOVIE')
    );

    if (!bestMatch) {
      if (scored[0]?.score < 0.1) return { names: [], year: null, notAnime: true };
      return { names: [name], year: null };
    }

    const best = bestMatch.m;
    const validRomaji = best.title?.romaji && isLatinScript(best.title.romaji) && !isJunkTitle(best.title.romaji) ? best.title.romaji : null;
    const names = [name, validRomaji].filter(Boolean);
    return { names: [...new Set(names)], year: best.startDate?.year || null };
  } catch { return { names: [], year: null }; }
}

async function resolveAnimeNames(type, fullId) {
  const cacheKey = `names:${type}:${fullId}`;
  const cached = nameCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < NAME_CACHE_TTL) return cached.data;

  let result = { names: [], year: null };
  if (fullId.startsWith('kitsu:')) {
    result = await getNamesFromKitsu(fullId.split(':')[1]);
  } else {
    result = await getNamesFromIMDb(type, fullId.split(':')[0]);
  }

  nameCache.set(cacheKey, { data: result, timestamp: result.names.length ? Date.now() : Date.now() - NAME_CACHE_TTL + 60000 });
  return result;
}

function parseEpisodeAndSeason(fullId) {
  const parts = fullId.split(':');
  if (fullId.startsWith('kitsu:')) return { season: 1, episode: parseInt(parts[2]) || 1 };
  if (parts.length >= 3) return { season: parseInt(parts[1]) || 1, episode: parseInt(parts[2]) || 1 };
  return { season: 1, episode: parseInt(parts[1]) || 1 };
}

// Cleanup stale name cache
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nameCache) if (now - v.timestamp > NAME_CACHE_TTL) nameCache.delete(k);
}, 30 * 60 * 1000);

module.exports = {
  getTodayAnime, searchTMDB, getTMDBImages,
  resolveAnimeNames, parseEpisodeAndSeason, normalizeMacrons,
};
