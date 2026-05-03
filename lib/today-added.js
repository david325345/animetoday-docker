const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cinemeta = require('./cinemeta');

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== Refresh cache: fetch today-added + Cinemeta enrichment =====
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

  // Enrich with Cinemeta — sequential, gentle pace (no rate limit known but be polite)
  const enriched = [];
  for (const item of items) {
    if (!item.imdb_id) {
      // No IMDB → can't fetch from Cinemeta. Keep item without enrichment.
      enriched.push({ ...item, meta: null });
      continue;
    }
    const stremioType = item.type === 'MOVIE' ? 'movie' : 'series';
    const meta = await cinemeta.fetchMeta(item.imdb_id, stremioType);
    enriched.push({ ...item, meta });
    await sleep(150); // polite spacing
  }

  todayAddedCache = enriched;
  cacheTime = Date.now();
  const ms = Date.now() - t0;
  const enrichedCount = enriched.filter(i => i.meta).length;
  console.log(`✅ today-added cache: ${enriched.length} items (${enrichedCount} with Cinemeta meta) (${(ms / 1000).toFixed(1)}s)`);

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

// ===== Generate posters using Cinemeta poster URL =====
async function generateTodayAddedPosters(items) {
  const posters = require('./posters');
  console.log(`🖼️ Generating today-added posters for ${items.length} items...`);
  const t0 = Date.now();
  let ok = 0;

  // Cleanup: remove ta_* posters that don't match current items (anime no longer in today-added)
  const currentIds = new Set(items.filter(i => i.anilist_id).map(i => `ta_${i.anilist_id}.png`));
  try {
    for (const f of fs.readdirSync(POSTERS_DIR)) {
      if (!f.startsWith('ta_')) continue;
      if (!currentIds.has(f)) {
        fs.unlinkSync(path.join(POSTERS_DIR, f));
      }
    }
  } catch {}

  for (const item of items) {
    const posterUrl = item.meta?.poster;
    if (!posterUrl) continue;

    // Build a "schedule-like" object for poster generator
    const fakeSchedule = {
      simklId: `ta_${item.anilist_id}`,
      posterUrl,
      // Top pill: episode label from indexer (S02E03, S02E03-09, Movie)
      topLabel: item.label,
      // Bottom: genre + rating from Cinemeta
      genres: item.meta?.genre ? [item.meta.genre] : [],
      malScore: item.meta?.imdbRating || null,
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
    : (item.meta?.poster || null);

  return {
    id: item.imdb_id,
    type: isMovie ? 'movie' : 'series',
    name: item.anime_title,
    poster: poster || 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image',
    description: `${item.label} · ${item.count} torrent${item.count !== 1 ? 's' : ''}`,
    releaseInfo: item.label,
    genres: item.meta?.genre ? [item.meta.genre] : [],
    imdbRating: item.meta?.imdbRating || undefined,
  };
}

module.exports = {
  refreshTodayAdded,
  getTodayAdded,
  buildMeta,
};
