const axios = require('axios');

// ===== Global rate limiter for AniList API =====
// AniList allows 90 req/min. We use 1000ms = 60 req/min (extra safe margin).
// All AniList requests across the app share this queue.
const MIN_DELAY_MS = 1000;
let lastRequestPromise = Promise.resolve();

function rateLimit() {
  const prev = lastRequestPromise;
  lastRequestPromise = (async () => {
    await prev;
    await new Promise(r => setTimeout(r, MIN_DELAY_MS));
  })();
  return prev;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== Core request with 429 retry =====
async function alRequest(query, variables, retriesLeft = 3) {
  await rateLimit();
  try {
    const resp = await axios.post('https://graphql.anilist.co', { query, variables }, { timeout: 10000 });
    return resp.data?.data || null;
  } catch (err) {
    const status = err.response?.status;
    if ((status === 429 || status === 503) && retriesLeft > 0) {
      const retryAfter = parseInt(err.response.headers?.['retry-after']) || 5;
      console.warn(`  ⏳ AniList ${status}, retry-after ${retryAfter}s (${retriesLeft} retries left)`);
      await sleep(retryAfter * 1000 + 500);
      return alRequest(query, variables, retriesLeft - 1);
    }
    throw err;
  }
}

// ===== Public: fetch genre, score, coverImage by AniList ID =====
async function fetchDetails(anilistId) {
  if (!anilistId) return null;
  try {
    const data = await alRequest(`
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          averageScore
          genres
          coverImage { extraLarge large }
        }
      }
    `, { id: parseInt(anilistId) });
    const m = data?.Media;
    if (!m) return null;
    return {
      score: m.averageScore ? (m.averageScore / 10).toFixed(1) : null,
      genre: (m.genres && m.genres[0]) || null,
      coverImage: m.coverImage?.extraLarge || m.coverImage?.large || null,
    };
  } catch (err) {
    console.error(`  ❌ AniList ${anilistId}: ${err.message}`);
    return null;
  }
}

// ===== Public: fetch only score (used by SIMKL) =====
async function fetchScore(anilistId) {
  if (!anilistId) return null;
  try {
    const data = await alRequest(`
      query ($id: Int) {
        Media(id: $id, type: ANIME) { averageScore }
      }
    `, { id: parseInt(anilistId) });
    const score = data?.Media?.averageScore;
    return score ? (score / 10).toFixed(1) : null;
  } catch {
    return null;
  }
}

module.exports = { fetchDetails, fetchScore };
