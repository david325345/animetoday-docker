const axios = require('axios');

// ===== Episodes already on the indexer today =====
// Fed by the indexer's push notice (POST /api/indexer/new-episodes) and synced
// from GET /api/today-episodes at startup, after the schedule refresh and
// hourly (fallback for notices lost while the addon was down). Keyed by the
// AniList id + episode in AniList numbering — the same key the AniList
// schedule carries (alEpisode), also for anime without an IMDb id yet.
// Resets at midnight Europe/Prague, like the indexer's own "today".

const INDEXER_URL = (process.env.INDEXER_URL || 'http://indexer:3003').replace(/\/$/, '');

const pragueYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

let dayKey = pragueYmd();
const seen = new Map(); // anilistId → Set(episode)
let syncUnavailableLogged = false;

function rollDay() {
  const k = pragueYmd();
  if (k !== dayKey) { dayKey = k; seen.clear(); }
}

// items: [{ anilist_id, episodes: [{ episode, … }] }] — the indexer's grouped
// shape. A flat { anilist_id, episode } item is accepted too.
// Returns the number of (anime, episode) pairs that were new.
function addItems(items) {
  rollDay();
  let added = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const al = Number(it?.anilist_id);
    if (!al) continue;
    const eps = Array.isArray(it.episodes) ? it.episodes : (it.episode != null ? [{ episode: it.episode }] : []);
    let set = seen.get(al);
    if (!set) { set = new Set(); seen.set(al, set); }
    for (const e of eps) {
      const ep = Number(e?.episode);
      if (Number.isFinite(ep) && !set.has(ep)) { set.add(ep); added++; }
    }
  }
  return added;
}

function isOnIndexer(anilistId, episode) {
  rollDay();
  if (!anilistId || episode == null) return false;
  return !!seen.get(Number(anilistId))?.has(Number(episode));
}

async function syncFromIndexer() {
  try {
    const r = await axios.get(`${INDEXER_URL}/api/today-episodes`, { timeout: 8000 });
    const added = addItems(r.data?.items);
    syncUnavailableLogged = false;
    if (added) console.log(`📥 indexer today-episodes: +${added} (${stats().episodes} today)`);
    return added;
  } catch (e) {
    // Until the indexer has the endpoint, say so once instead of every hour.
    if (e.response?.status === 404) {
      if (!syncUnavailableLogged) console.log('📥 indexer /api/today-episodes not available yet — relying on push notices');
      syncUnavailableLogged = true;
    } else {
      console.log(`📥 indexer today-episodes sync: ${e.message}`);
    }
    return 0;
  }
}

function stats() {
  rollDay();
  let episodes = 0;
  for (const s of seen.values()) episodes += s.size;
  return { day: dayKey, anime: seen.size, episodes };
}

module.exports = { addItems, isOnIndexer, syncFromIndexer, stats };
