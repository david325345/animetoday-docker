const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getTMDBKey } = require('./config');
const { alRequest } = require('./anilist-client');
const { formatTimeCET, getDayLabel } = require('./simkl');

// ===== Anime Today schedule from AniList (replaces the SIMKL calendar) =====
// Same output contract as lib/simkl.js fetchAnimeSchedule(), so server.js and
// posters.js keep working unchanged. Why AniList:
//   - SIMKL's calendar was missing about half of the episodes airing on a day
//     and its per-cour → TVDB conversion drifted on new cours (BEYBLADE X E136
//     instead of E135, S02E01 instead of S02E13).
//   - AniList lists every airing episode with its own id + episode number, the
//     same key the indexer resolves torrents to.
// IMDb is not on AniList, so it comes from a chain, first hit wins:
//   1. indexer /api/resolve-ids?anilist=&episode=  → imdb + exact Stremio S/E
//   2. Wikidata (AniList ID P8729 → IMDb P345)     → ID based, very precise
//   3. TMDB title search (+ native-title / year validation) → external_ids
//   4. Cinemeta search (exact title + year)        → last resort
// Measured on a 7-day window (96 anime): indexer 62, chain total 82 (85 %).

const INDEXER_URL = (process.env.INDEXER_URL || 'http://indexer:3003').replace(/\/$/, '');
const DAYS = 3; // today + 2, same window as the SIMKL calendar filter
const COUNTRIES = (process.env.ANIME_COUNTRIES || 'JP').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const CACHE_PATH = path.join(__dirname, '..', 'data', 'anilist-imdb-cache.json');
const POSITIVE_TTL = 7 * 24 * 3600 * 1000;   // external hits are re-checked weekly
const NEGATIVE_TTL = 12 * 3600 * 1000;        // "no IMDb yet" is retried twice a day

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== Time helpers (Europe/Prague, like the SIMKL module) =====
function pragueDayStart(date = new Date()) {
  const ymd = date.toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
  const off = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Prague' }))
    - new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.floor((Date.parse(ymd + 'T00:00:00Z') - off) / 1000);
}

function getAiringDay(dateStr) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
  const itemStr = new Date(dateStr).toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
  return Math.round((new Date(itemStr) - new Date(todayStr)) / (24 * 3600 * 1000));
}

// ===== Title helpers =====
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
// Native titles: drop whitespace, ideographic space and punctuation only.
const nativeNorm = s => String(s || '').replace(/[\s　・:：!！?？\-‐–—~〜()（）「」『』【】.,、。'"]/g, '').toLowerCase();

const WORD_ORD = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };

// Strip season / part / cour suffixes so the title matches the series-level
// entry TMDB and IMDb keep (they store a whole franchise as one show).
// Returns the base title plus a season number when the suffix gave one, and
// whether the suffix was a "part/cour" split (season unknown then).
function stripSeasonSuffix(title) {
  let t = String(title || '').trim();
  let season = null, split = false, stripped = false;
  t = t.replace(/\s*\(TV\)\s*$/i, '').replace(/\s*\((?:19|20)\d\d\)\s*$/, '').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    let m;
    if ((m = t.match(/^(.*?)[\s:,\-–]+(?:the\s+)?(\d+)(?:st|nd|rd|th)\s+(season|cour|part)\s*$/i))) {
      t = m[1]; if (/season/i.test(m[3])) season = season || +m[2]; else split = true;
    } else if ((m = t.match(/^(.*?)[\s:,\-–]+(season|cour|part)\s*(\d+)\s*$/i))) {
      t = m[1]; if (/season/i.test(m[2])) season = season || +m[3]; else split = true;
    } else if ((m = t.match(/^(.*?)[\s:,\-–]+(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(season|cour|part)\s*$/i))) {
      t = m[1]; if (/season/i.test(m[3])) season = season || WORD_ORD[m[2].toLowerCase()]; else split = true;
    } else if ((m = t.match(/^(.*?)\s+(II|III|IV|V|VI|VII|VIII|IX)\s*$/))) {
      t = m[1]; season = season || ROMAN[m[2].toLowerCase()];
    } else if ((m = t.match(/^(.{3,}?)\s+([2-9])\s*$/)) && !/(?:\bno\.?|\bvol\.?|#)$/i.test(m[1])) {
      t = m[1]; season = season || +m[2];
    }
    t = t.replace(/[\s:,\-–]+$/, '').trim();
    if (t === before) break;
    stripped = true;
  }
  return { base: t, season, split, stripped };
}

// ===== AniList: all episodes airing in the window =====
const SCHEDULE_QUERY = `
query ($p: Int, $s: Int, $e: Int) {
  Page(page: $p, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $s, airingAt_lesser: $e, sort: TIME) {
      airingAt
      episode
      media {
        id idMal format isAdult countryOfOrigin episodes
        startDate { year }
        title { romaji english native }
        genres averageScore
        coverImage { extraLarge large }
        bannerImage
        description(asHtml: false)
        studios(isMain: true) { nodes { name } }
        relations { edges { relationType node { type format } } }
      }
    }
  }
}`;

async function fetchAiring() {
  const start = pragueDayStart();
  const end = start + DAYS * 86400;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await alRequest(SCHEDULE_QUERY, { p: page, s: start - 1, e: end });
    const pg = data?.Page;
    if (!pg) break;
    out.push(...(pg.airingSchedules || []));
    if (!pg.pageInfo?.hasNextPage) break;
  }
  return out;
}

// ===== Persistent cache for IMDb found outside the indexer =====
let imdbCache = null;
function loadCache() {
  if (imdbCache) return imdbCache;
  try { imdbCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { imdbCache = {}; }
  return imdbCache;
}
function saveCache() {
  try { fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true }); fs.writeFileSync(CACHE_PATH, JSON.stringify(imdbCache)); }
  catch (e) { console.log(`  ⚠️ anilist-imdb cache write: ${e.message}`); }
}

// ===== 1) Indexer =====
async function resolveViaIndexer(anilistId, episode) {
  try {
    const r = await axios.get(`${INDEXER_URL}/api/resolve-ids`, {
      params: { anilist: anilistId, episode }, timeout: 8000,
    });
    return r.data || null;
  } catch { return null; }
}

// ===== 2) Wikidata (one query for all ids) =====
async function wikidataBatch(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const sparql = `SELECT ?al ?imdb WHERE { VALUES ?al { ${chunk.map(id => `"${id}"`).join(' ')} } ?item wdt:P8729 ?al . ?item wdt:P345 ?imdb . }`;
    try {
      const r = await axios.get('https://query.wikidata.org/sparql', {
        params: { format: 'json', query: sparql },
        headers: { 'User-Agent': 'animetoday-addon/1.0', Accept: 'application/sparql-results+json' },
        timeout: 15000,
      });
      for (const b of r.data?.results?.bindings || []) {
        if (/^tt\d+$/.test(b.imdb?.value || '')) out.set(Number(b.al.value), b.imdb.value);
      }
    } catch (e) { console.log(`  ⚠️ Wikidata: ${e.message}`); }
  }
  return out;
}

// ===== 3) TMDB title search with validation =====
async function resolveViaTmdb(media, info) {
  const key = getTMDBKey();
  if (!key) return null;
  const native = nativeNorm(media.title.native);
  const alYear = media.startDate?.year || null;
  const queries = [];
  for (const t of [media.title.english, media.title.romaji]) {
    if (!t) continue;
    const s = stripSeasonSuffix(t).base;
    if (s && !queries.includes(s)) queries.push(s);
    // Arc subtitles ("Tougen Anki: Nikko Kegon no Taki-hen") — try the part
    // before the colon for sequels, where TMDB only knows the series name.
    if (info.isSequel && s.includes(':')) {
      const head = s.split(':')[0].trim();
      if (head.length >= 3 && !queries.includes(head)) queries.push(head);
    }
  }
  for (const q of queries) {
    let results = [];
    try {
      const params = { api_key: key, query: q };
      if (!info.isSequel && alYear) params.first_air_date_year = alYear;
      let r = await axios.get('https://api.themoviedb.org/3/search/tv', { params, timeout: 8000 });
      results = r.data?.results || [];
      if (!results.length && params.first_air_date_year) {
        delete params.first_air_date_year;
        r = await axios.get('https://api.themoviedb.org/3/search/tv', { params, timeout: 8000 });
        results = r.data?.results || [];
      }
    } catch { continue; }
    results = results.filter(x => ['ja', 'zh', 'ko'].includes(x.original_language));
    let pick = null, how = '';
    // Strong: native title matches (or one is a prefix of the other — native
    // sequel titles carry "第2期"/"2nd season" tails).
    if (native.length >= 2) {
      pick = results.find(x => {
        const n = nativeNorm(x.original_name);
        if (!n || !(n === native || (n.length >= 4 && native.startsWith(n)) || (native.length >= 4 && n.startsWith(native)))) return false;
        // A remake shares the native title with its original — for a title
        // that is not a sequel, the show must not start years earlier.
        const y = parseInt((x.first_air_date || '').slice(0, 4));
        return info.isSequel || !y || !alYear || y >= alYear - 1;
      });
      if (pick) how = 'native';
    }
    // Fuzzy: animation + plausible year. A sequel belongs to an older show
    // (TMDB year ≤ AniList year); a new title must start within ±1 year,
    // otherwise remakes match their 30-year-old original (Rayearth 2026 → 1994).
    if (!pick) {
      pick = results.find(x => {
        const y = parseInt((x.first_air_date || '').slice(0, 4));
        if (!(x.genre_ids || []).includes(16) || !y || !alYear) return false;
        return info.isSequel ? y <= alYear : Math.abs(y - alYear) <= 1;
      });
      if (pick) how = 'fuzzy';
    }
    if (!pick) continue;
    try {
      const e = await axios.get(`https://api.themoviedb.org/3/tv/${pick.id}/external_ids`, { params: { api_key: key }, timeout: 8000 });
      return { imdb: e.data?.imdb_id || null, tmdb: pick.id, tvdb: e.data?.tvdb_id || null, how, name: pick.name };
    } catch { return { imdb: null, tmdb: pick.id, tvdb: null, how, name: pick.name }; }
  }
  return null;
}

// ===== 4) Cinemeta search (exact title + year) =====
async function resolveViaCinemeta(media, info) {
  const alYear = media.startDate?.year || null;
  const names = [media.title.english, media.title.romaji].filter(Boolean).map(t => stripSeasonSuffix(t).base);
  const wanted = new Set(names.map(norm).filter(Boolean));
  for (const q of names) {
    try {
      const r = await axios.get(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`, { timeout: 8000 });
      const hit = (r.data?.metas || []).find(m => {
        if (!/^tt\d+$/.test(m.id || '') || !wanted.has(norm(m.name))) return false;
        const y = parseInt(String(m.releaseInfo || '').slice(0, 4));
        if (!y || !alYear) return true;
        return info.isSequel ? y <= alYear : Math.abs(y - alYear) <= 1;
      });
      if (hit) return hit.id;
    } catch {}
  }
  return null;
}

// ===== Parallel map with a small concurrency limit =====
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ===== Main: same contract as simkl.fetchAnimeSchedule() =====
async function fetchAnimeSchedule() {
  const t0 = Date.now();
  console.log('🔄 Fetching AniList anime schedule...');

  let airing;
  try { airing = await fetchAiring(); }
  catch (e) { console.error(`❌ AniList schedule: ${e.message}`); return []; }

  const items = airing.filter(a => a.media && !a.media.isAdult
    && COUNTRIES.includes(a.media.countryOfOrigin) && a.media.format !== 'MUSIC');
  console.log(`📅 AniList: ${airing.length} airings, ${items.length} after filter (${COUNTRIES.join('/')}, no adult/music)`);
  if (!items.length) return [];

  // Per-media facts used by the external lookups
  const mediaInfo = new Map();
  for (const a of items) {
    const m = a.media;
    if (mediaInfo.has(m.id)) continue;
    const st = stripSeasonSuffix(m.title.english || m.title.romaji);
    const stR = stripSeasonSuffix(m.title.romaji);
    const hasPrequel = (m.relations?.edges || []).some(e => e.relationType === 'PREQUEL' && e.node?.type === 'ANIME'
      && ['TV', 'TV_SHORT', 'ONA', 'OVA'].includes(e.node.format));
    mediaInfo.set(m.id, {
      media: m,
      isSequel: hasPrequel || st.stripped || stR.stripped,
      titleSeason: st.season || stR.season || null,
      split: st.split || stR.split,
    });
  }

  // 1) Indexer, per airing (episode-specific S/E)
  const resolved = await pMap(items, 6, a => resolveViaIndexer(a.media.id, a.episode));

  // 2–4) External chain for media the indexer has no IMDb for
  const cache = loadCache();
  const now = Date.now();
  const external = new Map(); // anilistId → { imdb, tmdb, tvdb, src }
  const missing = [...new Set(items.filter((a, i) => !resolved[i]?.imdb_id).map(a => a.media.id))];
  const toLookup = [];
  for (const id of missing) {
    const c = cache[id];
    if (c && c.imdb && now - c.ts < POSITIVE_TTL) external.set(id, c);
    else if (c && !c.imdb && now - c.ts < NEGATIVE_TTL) { /* recently failed — skip */ }
    else toLookup.push(id);
  }
  const stats = { indexer: 0, cached: external.size, wikidata: 0, tmdb: 0, cinemeta: 0, none: 0 };

  if (toLookup.length) {
    const wd = await wikidataBatch(toLookup);
    for (const id of toLookup) {
      const info = mediaInfo.get(id);
      let hit = null;
      if (wd.has(id)) { hit = { imdb: wd.get(id), src: 'wikidata' }; stats.wikidata++; }
      if (!hit) {
        const t = await resolveViaTmdb(info.media, info);
        if (t?.imdb) { hit = { imdb: t.imdb, tmdb: t.tmdb, tvdb: t.tvdb, src: `tmdb-${t.how}` }; stats.tmdb++; }
        else if (t?.tmdb) hit = { imdb: null, tmdb: t.tmdb, tvdb: t.tvdb, src: 'tmdb-noimdb' };
        await sleep(120);
      }
      if (!hit?.imdb) {
        const c = await resolveViaCinemeta(info.media, info);
        if (c) { hit = { ...(hit || {}), imdb: c, src: 'cinemeta' }; stats.cinemeta++; }
      }
      cache[id] = { ...(hit || { imdb: null }), ts: now };
      if (hit?.imdb) {
        external.set(id, cache[id]);
        console.log(`  🔗 ${info.media.title.romaji} (AL${id}) → ${hit.imdb} [${hit.src}]`);
      } else {
        stats.none++;
      }
    }
    saveCache();
  }

  // Build entries
  const schedules = items.map((a, i) => {
    const m = a.media;
    const info = mediaInfo.get(m.id);
    const r = resolved[i];
    const alEpisode = a.episode;
    const airingAt = new Date(a.airingAt * 1000).toISOString();

    let imdbId = null, season = null, episode = alEpisode, seasonUnknown = false, imdbSource = null;
    if (r?.imdb_id) {
      imdbId = r.imdb_id;
      imdbSource = 'indexer';
      season = r.season ?? null;
      episode = r.episode ?? alEpisode;
      if (season == null) seasonUnknown = info.isSequel;
    } else {
      const ext = external.get(m.id);
      if (ext?.imdb) { imdbId = ext.imdb; imdbSource = ext.src; }
      // Without the indexer's mapping the Stremio season is only certain for
      // first seasons; "Season N" in the title is trusted, a part/cour split
      // or an untitled sequel shows just "Ep N".
      if (!info.isSequel) season = 1;
      else if (info.titleSeason && !info.split) season = info.titleSeason;
      else seasonUnknown = true;
    }

    const score = m.averageScore ? (m.averageScore / 10).toFixed(1) : null;
    return {
      // Core (simklId keeps its role as the per-anime key: hidden list, poster file)
      simklId: m.id,
      posterKey: `al${m.id}_${alEpisode}`,
      title: m.title.romaji || m.title.english,
      enTitle: m.title.english || null,
      episode,
      season,
      seasonUnknown,
      simklEpisode: alEpisode,
      alEpisode,
      year: m.startDate?.year || null,
      airingAt,
      dayOffset: getAiringDay(airingAt),
      animeType: String(m.format || '').toLowerCase(),

      // IDs
      imdbId,
      imdbSource,
      anilistId: m.id,
      malId: m.idMal || r?.mal_id || null,
      tvdbId: r?.tvdb_id || external.get(m.id)?.tvdb || null,
      tmdbId: r?.tmdb_id || external.get(m.id)?.tmdb || null,
      kitsuId: r?.kitsu_id || null,

      // Images
      posterUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
      fanartUrl: m.bannerImage || null,
      posterPath: null,

      // Metadata
      overview: (m.description || '').replace(/<[^>]*>/g, '').trim(),
      genres: m.genres || [],
      totalEpisodes: m.episodes || null,
      network: '',
      studios: (m.studios?.nodes || []).map(n => n.name),

      // Ratings (poster shows malScore — fed with the AniList score here)
      malScore: score,
      anilistScore: score,
      simklRating: null,

      source: 'anilist',
      generatedPoster: null,
    };
  });

  stats.indexer = resolved.filter(r => r?.imdb_id).length;
  const withImdb = schedules.filter(s => s.imdbId).length;
  console.log(`✅ AniList schedule: ${schedules.length} entries, IMDb ${withImdb} (indexer ${stats.indexer} airings; new lookups: wikidata ${stats.wikidata}, tmdb ${stats.tmdb}, cinemeta ${stats.cinemeta}, none ${stats.none}; cached ${stats.cached}) (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return schedules;
}

module.exports = {
  fetchAnimeSchedule,
  formatTimeCET,
  getDayLabel,
  stripSeasonSuffix, // exported for tests
};
