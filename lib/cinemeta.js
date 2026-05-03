const axios = require('axios');

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

// ===== Cache =====
const cache = new Map();
const TTL = 24 * 60 * 60 * 1000; // 24h

// Clean stale entries every hour to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, val] of cache.entries()) {
    if (now - val.t > TTL) {
      cache.delete(key);
      removed++;
    }
  }
  if (removed > 0) console.log(`🧹 Cinemeta cache cleanup: removed ${removed} stale entries`);
}, 60 * 60 * 1000);

// ===== Fetch meta from Cinemeta =====
// Returns { poster, background, name, genres, imdbRating, description } or null
async function fetchMeta(imdbId, type = 'series') {
  if (!imdbId) return null;
  const cacheKey = `${type}:${imdbId}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.t < TTL) {
    return cached.data;
  }

  try {
    const resp = await axios.get(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const meta = resp.data?.meta;
    if (!meta) {
      cache.set(cacheKey, { t: Date.now(), data: null });
      return null;
    }

    const data = {
      poster: meta.poster || null,
      background: meta.background || null,
      name: meta.name || null,
      genres: meta.genres || [],
      genre: (meta.genres && meta.genres[0]) || null,
      imdbRating: meta.imdbRating || null,
      description: meta.description || null,
    };
    cache.set(cacheKey, { t: Date.now(), data });
    return data;
  } catch (err) {
    // Cinemeta returns 404 for unknown IDs — cache the miss briefly to avoid retry storms
    cache.set(cacheKey, { t: Date.now(), data: null });
    return null;
  }
}

module.exports = { fetchMeta };
