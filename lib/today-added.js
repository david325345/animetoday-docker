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
let refreshInFlight = null; // dedupe concurrent refreshes (startup + cron + lazy)
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

// ===== Refresh cache: fetch today-added + Cinemeta enrichment + posters =====
// Reliability model (mirrors the airing schedule cache):
//   1. The live cache is swapped in ONLY after overlay posters are generated,
//      so a reader never observes a window where generatedPoster is missing
//      (which is what made overlays appear only on the 2nd–3rd catalog load).
//   2. Concurrent callers (startup pre-warm, cron, lazy refresh) share one
//      in-flight refresh — no thundering herd.
function refreshTodayAdded() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = _doRefreshTodayAdded()
    .catch(err => console.error('today-added refresh:', err.message))
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function _doRefreshTodayAdded() {
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

  const ms = Date.now() - t0;
  const enrichedCount = enriched.filter(i => i.meta).length;
  console.log(`✅ today-added enriched: ${enriched.length} items (${enrichedCount} with Cinemeta meta) (${(ms / 1000).toFixed(1)}s, generating posters...)`);

  // Generate overlay posters BEFORE publishing the new cache. generatePoster
  // mutates each item in-place (sets item.generatedPoster), so once this
  // resolves the array is fully warm. Readers keep getting the previous warm
  // cache until the atomic swap below — they never see un-overlaid posters.
  await generateTodayAddedPosters(enriched);

  todayAddedCache = enriched;   // atomic swap to the fully-warmed array
  cacheTime = Date.now();

  // Drop poster files for anime no longer in today-added — AFTER the swap,
  // so the previous cache never references a just-deleted file.
  cleanupStalePosters(enriched);
}

// ===== Get cache (stale-while-revalidate) =====
// Cold cache → block until the first full refresh (posters included) so the
// very first catalog load already has overlays. Warm but stale → serve the
// current fully-warmed cache immediately and refresh in the background, so a
// user request is never the one that observes the no-poster window.
async function getTodayAdded() {
  const stale = Date.now() - cacheTime > CACHE_TTL;
  if (!todayAddedCache.length) {
    await refreshTodayAdded();
  } else if (stale) {
    refreshTodayAdded(); // background, do not await
  }
  return todayAddedCache;
}

// ===== Generate posters using Cinemeta poster URL =====
async function generateTodayAddedPosters(items) {
  const posters = require('./posters');
  console.log(`🖼️ Generating today-added posters for ${items.length} items...`);
  const t0 = Date.now();
  let ok = 0;

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

// ===== Remove ta_* poster files for anime no longer in today-added =====
function cleanupStalePosters(items) {
  const currentIds = new Set(items.filter(i => i.anilist_id).map(i => `ta_${i.anilist_id}.png`));
  try {
    for (const f of fs.readdirSync(POSTERS_DIR)) {
      if (!f.startsWith('ta_')) continue;
      if (!currentIds.has(f)) fs.unlinkSync(path.join(POSTERS_DIR, f));
    }
  } catch {}
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
