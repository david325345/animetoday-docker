const axios = require('axios');

// ===== Global rate limiter for AniList API =====
// AniList allows 90 req/min. We pace at 1500ms (= 40 req/min, safe margin).
// All AniList requests share this single queue (no concurrent execution).
const MIN_DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// === Strict serial queue ===
// Every request appends to `queueTail`. Only one request executes at a time.
let queueTail = Promise.resolve();
let pausedUntil = 0; // unix ms — when current global pause ends (after 429)

function enqueue(taskFn) {
  const next = queueTail.then(async () => {
    // Honor global pause from previous 429
    const now = Date.now();
    if (pausedUntil > now) {
      await sleep(pausedUntil - now);
    }

    const result = await taskFn();
    // Throttle pacing
    await sleep(MIN_DELAY_MS);
    return result;
  });
  // Make sure queue continues even if task throws
  queueTail = next.catch(() => {});
  return next;
}

function pauseFor(seconds) {
  // Add ~1s buffer
  pausedUntil = Math.max(pausedUntil, Date.now() + seconds * 1000 + 1000);
}

// ===== Core request with 429 retry =====
async function alRequest(query, variables, retriesLeft = 3) {
  return enqueue(async () => {
    try {
      const resp = await axios.post('https://graphql.anilist.co', { query, variables }, { timeout: 15000 });
      return resp.data?.data || null;
    } catch (err) {
      const status = err.response?.status;
      if ((status === 429 || status === 503) && retriesLeft > 0) {
        const retryAfter = parseInt(err.response.headers?.['retry-after']) || 5;
        console.warn(`  ⏳ AniList ${status}, pausing all requests for ${retryAfter}s`);
        pauseFor(retryAfter);
        // Re-enter the queue (waits for pause + own delay)
        return alRequest(query, variables, retriesLeft - 1);
      }
      throw err;
    }
  });
}

// ===== Public: fetch genre, score, coverImage =====
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

// ===== Public: fetch only score =====
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

// ===== Public: search by name =====
async function searchByName(searchName) {
  if (!searchName) return null;
  try {
    const data = await alRequest(`
      query ($search: String) {
        Page(page: 1, perPage: 5) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
            title { romaji english }
          }
        }
      }
    `, { search: searchName });
    return data?.Page?.media || null;
  } catch {
    return null;
  }
}

module.exports = { fetchDetails, fetchScore, searchByName };
