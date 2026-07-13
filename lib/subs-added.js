const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cinemeta = require('./cinemeta');

// "Nově otitulkované" catalog — mirrors lib/today-added.js, but sourced from the
// NimeToDex Titulky service (/api/recent) instead of the indexer. Flow:
//   /api/recent?days=7 → per anime: resolve-ids (AL→imdb) → dedup by imdb
//   (per-Part AL entries of one series merge into one catalog item) →
//   Cinemeta enrichment → overlay posters (top pill = "CZ/SK · E1–11").
const SUBS_API_URL = (process.env.SUBS_API_URL || 'http://titulky:8080').replace(/\/$/, '');
const INDEXER_URL = (process.env.INDEXER_URL || 'http://indexer:3003').replace(/\/$/, '');
// Window: TODAY ONLY (service default = since midnight, server time) — per request
// 2026-07-12. When empty (mornings), the catalog shows a placeholder card instead
// of an empty/hidden row.
const POSTERS_DIR = path.join(__dirname, '..', 'public', 'posters');
try { fs.mkdirSync(POSTERS_DIR, { recursive: true }); } catch {}

// ===== Cache =====
let subsAddedCache = [];
let cacheTime = 0;
let refreshInFlight = null;
const CACHE_TTL = 60 * 60 * 1000; // 1h (hourly cron mirrors this)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== Pill label: "CZ · E6" / "CZ/SK · E1–11" =====
// NEVER emits a comma — posters.simplifyEpisodeLabel() rewrites comma-separated
// labels and would mangle this format. Ranges collapse gaps on purpose; the
// precise per-episode breakdown lives in the meta description.
function buildPillLabel(langs, episodes, season) {
  const langPart = langs.join('/');
  const eps = episodes.map(e => e.episode).sort((a, b) => a - b);
  if (!eps.length) return langPart;
  // Season prefix only for S2+ — S1 and absolute entries (One Piece, season null)
  // stay short: "CZ · E6" / "CZ · E1094"; Mushoku S3 → "CZ · S3E1–11".
  const sPrefix = season && season > 1 ? `S${season}` : '';
  const epPart = eps.length === 1 ? `${sPrefix}E${eps[0]}` : `${sPrefix}E${eps[0]}–${eps[eps.length - 1]}`;
  return `${langPart} · ${epPart}`;
}

// ===== Fetch /api/recent from the subs service =====
async function fetchRecent() {
  try {
    const resp = await axios.get(`${SUBS_API_URL}/api/recent`, { timeout: 10000 });
    return resp.data?.items || [];
  } catch (err) {
    console.error(`  ❌ subs-added fetch: ${err.message}`);
    return [];
  }
}

// ===== AL/MAL → imdb via indexer resolve-ids =====
async function resolveIds(item) {
  const params = item.anilist_id ? `anilist=${item.anilist_id}`
    : item.mal_id ? `mal=${item.mal_id}` : null;
  if (!params) return null;
  try {
    const r = await axios.get(`${INDEXER_URL}/api/resolve-ids?${params}`, { timeout: 8000 });
    if (!r.data?.imdb_id) return null;
    return { imdb: r.data.imdb_id, season: r.data.season ?? null };
  } catch {
    return null; // 404 = no mapping → item skipped
  }
}

// ===== Refresh (same reliability model as today-added: atomic swap after posters) =====
function refreshSubsAdded() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = _doRefresh()
    .catch(err => console.error('subs-added refresh:', err.message))
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function _doRefresh() {
  console.log('🔄 Refreshing subs-added cache...');
  const t0 = Date.now();

  const raw = await fetchRecent();
  if (!raw.length) {
    subsAddedCache = [];
    cacheTime = Date.now();
    console.log('  📋 subs-added: 0 items');
    return;
  }

  // Resolve imdb+season, dedup by imdb with PER-SEASON groups: Parts of the
  // same season merge their episodes; different seasons stay separate groups so
  // a pill never mixes "S1 E5" and "S3 E1–11" into one bogus range.
  const byImdb = new Map();
  for (const item of raw) {
    const ids = await resolveIds(item);
    await sleep(100);
    if (!ids) { console.log(`  ⚠️ subs-added: no imdb for AL${item.anilist_id}/MAL${item.mal_id} "${item.anime_title}"`); continue; }
    const seasonKey = ids.season == null ? 'abs' : String(ids.season);
    let rec = byImdb.get(ids.imdb);
    if (!rec) {
      rec = { imdb_id: ids.imdb, anime_title: item.anime_title, latest_first_seen: item.latest_first_seen, groups: new Map() };
      byImdb.set(ids.imdb, rec);
    }
    const grp = rec.groups.get(seasonKey);
    if (!grp) {
      rec.groups.set(seasonKey, { season: ids.season, episodes: [...item.episodes], latest: item.latest_first_seen });
    } else {
      grp.episodes.push(...item.episodes);
      if (new Date(item.latest_first_seen) > new Date(grp.latest)) grp.latest = item.latest_first_seen;
    }
    if (new Date(item.latest_first_seen) > new Date(rec.latest_first_seen)) {
      rec.latest_first_seen = item.latest_first_seen;
      rec.anime_title = item.anime_title;
    }
  }
  const items = [...byImdb.values()]
    .sort((a, b) => new Date(b.latest_first_seen) - new Date(a.latest_first_seen));

  // Cinemeta enrichment + derived fields (pill = NEWEST season group; description
  // breaks down all groups precisely)
  for (const item of items) {
    item.meta = await cinemeta.fetchMeta(item.imdb_id, 'series');
    await sleep(150);
    const groups = [...item.groups.values()]
      .sort((a, b) => new Date(b.latest) - new Date(a.latest));
    const newest = groups[0];
    const newestLangs = [...new Set(newest.episodes.flatMap(e => e.langs || []))].sort();
    item.pillLabel = buildPillLabel(newestLangs, newest.episodes, newest.season);
    item.epBreakdown = groups.map(g => {
      const eps = g.episodes
        .slice().sort((a, b) => a.episode - b.episode)
        .map(e => `E${e.episode} (${(e.langs || []).join('/')})`).join(', ');
      return g.season && g.season > 1 ? `S${g.season}: ${eps}` : eps;
    }).join(' · ');
  }

  const enrichedCount = items.filter(i => i.meta).length;
  console.log(`✅ subs-added: ${items.length} items (${enrichedCount} with Cinemeta meta) (${((Date.now() - t0) / 1000).toFixed(1)}s, generating posters...)`);

  await generateSubsAddedPosters(items);

  subsAddedCache = items;  // atomic swap after posters are warm
  cacheTime = Date.now();
  cleanupStalePosters(items);
}

// ===== Stale-while-revalidate accessor =====
async function getSubsAdded() {
  const stale = Date.now() - cacheTime > CACHE_TTL;
  if (!subsAddedCache.length && !cacheTime) {
    await refreshSubsAdded();
  } else if (stale) {
    refreshSubsAdded(); // background
  }
  return subsAddedCache;
}

// ===== Posters (top pill = langs + episodes, bottom = genre + ★, same style) =====
async function generateSubsAddedPosters(items) {
  const posters = require('./posters');
  console.log(`🖼️ Generating subs-added posters for ${items.length} items...`);
  const t0 = Date.now();
  let ok = 0;
  for (const item of items) {
    const posterUrl = item.meta?.poster;
    if (!posterUrl) continue;
    const fakeSchedule = {
      simklId: `sa_${item.imdb_id}`,
      posterUrl,
      topLabel: item.pillLabel,
      genres: item.meta?.genres || [],
      malScore: item.meta?.imdbRating || null,
      isAdded: true,
    };
    try {
      const p = await posters.generatePoster(fakeSchedule);
      if (p) { item.generatedPoster = p; ok++; }
    } catch (err) {
      console.error(`  poster ${item.imdb_id}: ${err.message}`);
    }
  }
  console.log(`🖼️ subs-added posters: ${ok}/${items.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function cleanupStalePosters(items) {
  const current = new Set(items.map(i => `sa_${i.imdb_id}.png`));
  try {
    for (const f of fs.readdirSync(POSTERS_DIR)) {
      if (!f.startsWith('sa_')) continue;
      if (!current.has(f)) fs.unlinkSync(path.join(POSTERS_DIR, f));
    }
  } catch {}
}

// ===== Stremio meta =====
function buildMeta(item, baseUrl) {
  if (!item.imdb_id) return null;
  const poster = item.generatedPoster
    ? `${baseUrl}${item.generatedPoster}`
    : (item.meta?.poster || null);
  return {
    id: item.imdb_id,
    type: 'series',
    name: item.anime_title || item.meta?.name || 'Unknown',
    poster: poster || 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image',
    description: `Nové titulky: ${item.epBreakdown}`,
    releaseInfo: item.pillLabel,
    genres: item.meta?.genre ? [item.meta.genre] : [],
    imdbRating: item.meta?.imdbRating || undefined,
  };
}

// Placeholder card for the empty state (generated once per startup by server.js)
function buildPlaceholderMeta(baseUrl) {
  return {
    id: 'ntx-ph-subs',
    type: 'series',
    name: 'Nothing subbed yet today',
    poster: `${baseUrl}/posters/ph_subs.png`,
    description: 'New CZ/SK subtitles will show up here as they are added today.',
  };
}

module.exports = {
  refreshSubsAdded,
  getSubsAdded,
  buildMeta,
  buildPlaceholderMeta,
};
