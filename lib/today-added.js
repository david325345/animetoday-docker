const axios = require('axios');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const INDEXER_URL = (process.env.INDEXER_URL || 'https://nimetodex.duckdns.org').replace(/\/$/, '');
const POSTERS_DIR = path.join(__dirname, '..', 'public', 'posters');
try { fs.mkdirSync(POSTERS_DIR, { recursive: true }); } catch {}

// ===== Cache =====
let todayAddedCache = [];
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1h

// ===== Fetch today-added items from indexer =====
async function fetchTodayAdded() {
  try {
    const resp = await axios.get(`${INDEXER_URL}/api/today-added`, { timeout: 10000 });
    if (!resp.data?.enabled) return [];
    return resp.data.items || [];
  } catch (err) {
    console.error(`  ❌ today-added fetch: ${err.message}`);
    return [];
  }
}

// ===== Fetch AniList details (genre + rating + poster) =====
async function fetchAniListDetails(anilistId) {
  if (!anilistId) return null;
  try {
    const query = `query ($id: Int) {
      Media(id: $id, type: ANIME) {
        averageScore
        genres
        coverImage { extraLarge large }
      }
    }`;
    const resp = await axios.post('https://graphql.anilist.co', {
      query, variables: { id: parseInt(anilistId) }
    }, { timeout: 8000 });
    const m = resp.data?.data?.Media;
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== Refresh cache: fetch today-added + AniList enrichment =====
async function refreshTodayAdded() {
  console.log('🔄 Refreshing today-added cache...');
  const t0 = Date.now();

  const items = await fetchTodayAdded();
  if (!items.length) {
    todayAddedCache = [];
    cacheTime = Date.now();
    console.log('  📋 today-added: 0 items');
    return;
  }

  // Enrich with AniList — sequential with delay (rate limit safe, no rush)
  const enriched = [];
  for (const item of items) {
    const al = await fetchAniListDetails(item.anilist_id);
    enriched.push({ ...item, anilist: al });
    await sleep(700); // 700ms between requests = ~85 req/min, under 90 limit
  }

  todayAddedCache = enriched;
  cacheTime = Date.now();
  const ms = Date.now() - t0;
  console.log(`✅ today-added cache: ${enriched.length} items (${(ms / 1000).toFixed(1)}s)`);

  // Generate posters in background — non-blocking
  generateTodayAddedPosters(enriched).catch(err => console.error('Poster gen error:', err.message));
}

// ===== Get cache (auto-refresh if stale) =====
async function getTodayAdded() {
  const now = Date.now();
  if (now - cacheTime > CACHE_TTL || !todayAddedCache.length) {
    await refreshTodayAdded();
  }
  return todayAddedCache;
}

// ===== Generate posters (delegated to lib/posters) =====
async function generateTodayAddedPosters(items) {
  const posters = require('./posters');
  console.log(`🖼️ Generating today-added posters for ${items.length} items...`);
  const t0 = Date.now();
  let ok = 0;

  for (const item of items) {
    if (!item.anilist?.coverImage) continue;
    // Build a "schedule-like" object for poster generator
    const fakeSchedule = {
      simklId: `ta_${item.anilist_id}`,
      posterUrl: item.anilist.coverImage,
      // Top pill: episode label from indexer (S02E03, S02E03-09, Movie)
      topLabel: item.label,
      // Bottom: genre + rating from AniList
      genres: item.anilist.genre ? [item.anilist.genre] : [],
      malScore: item.anilist.score,
      // Mark as today-added so poster generator uses topLabel as-is (no date formatting)
      isAdded: true,
    };
    try {
      const p = await posters.generatePoster(fakeSchedule);
      if (p) {
        item.generatedPoster = p;
        ok++;
      }
    } catch (err) {
      console.error(`  poster ${item.anilist_id}: ${err.message}`);
    }
  }

  console.log(`🖼️ today-added posters: ${ok}/${items.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ===== Build Stremio meta from item =====
function buildMeta(item, baseUrl) {
  if (!item.imdb_id) return null;

  const isMovie = item.type === 'MOVIE';
  const poster = item.generatedPoster
    ? `${baseUrl}${item.generatedPoster}`
    : (item.anilist?.coverImage || null);

  return {
    id: item.imdb_id,
    type: isMovie ? 'movie' : 'series',
    name: item.anime_title,
    poster: poster || 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image',
    description: `${item.label} · ${item.count} torrent${item.count !== 1 ? 's' : ''}`,
    releaseInfo: item.label,
    genres: item.anilist?.genre ? [item.anilist.genre] : [],
    imdbRating: item.anilist?.score || undefined,
  };
}

module.exports = {
  refreshTodayAdded,
  getTodayAdded,
  buildMeta,
};
