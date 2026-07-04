/**
 * Offline anime database — name → IDs resolver v3
 * Much better title matching: alt names in parens, season numbers, English↔Romaji
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'anime-offline-database.json');
const ANIMELISTS_PATH = path.join(DATA_DIR, 'anime-lists.json');
const CACHE_PATH = path.join(DATA_DIR, 'name-cache.json');
// Fix #25: Persisted cache of adult (18+) anime fetched via authenticated AniList API.
// manami + fribb dumps filter these out, so we need our own store. Indexed by AL ID
// to the same record shape used by anilistIndex (so getByAniListId returns a full record).
const ADULT_CACHE_PATH = path.join(DATA_DIR, 'adult-anime-cache.json');

const MANAMI_URLS = [
  'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json',
  'https://raw.githubusercontent.com/manami-project/anime-offline-database/master/anime-offline-database-minified.json',
];
const ANIMELISTS_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const DB_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

let titleIndex = new Map();
let anilistIndex = new Map();
let anidbIndex = new Map();
let malIndex = new Map();
let animeListsIndex = new Map();
let tvdbOffsetTable = new Map(); // tvdbId → [{ season, anidbId, anilistId, offset, episodes }]

// ── Per-AniList ID overrides (Fix #95) ─────────────────────────────────────
// Some AniList entries have NO tvdb/imdb/season mapping in Fribb anime-lists, yet they
// ARE a specific season of a TVDB/Cinemeta series. The classic case is donghua
// continuation runs ("Nian Fan" / 年番 annual runs) that are numbered relative to
// themselves (run ep N = TVDB season-N E_N) but resolve to a standalone AniList ID with
// no franchise metadata, so buildRecord cannot know which season they belong to and
// defaults them to S1.
//
// Each override (a) patches the indexed record (tvdbId/tvdbSeason/imdb/tmdb) so
// getByAniListId + resolveByTitle return the corrected mapping, and (b) registers the AL
// in tvdbOffsetTable so buildRecord's `isFranchiseMemberRelative` path assigns the right
// season while KEEPING the uploader episode number (run ep N → SxxEN).
//
//   anilistId → { tvdbId, tvdbSeason, imdbId, tmdbId, episodes }
const ID_OVERRIDES = new Map([
  // Battle Through the Heavens / Doupo Cangqiong "Nian Fan" (年番) — TVDB/Cinemeta S5
  // (tt12409194 / tvdb 337284). Fribb has nothing for AL137728. NF ep N = S5EN.
  [137728, { tvdbId: 337284, tvdbSeason: 5, imdbId: 'tt12409194', tmdbId: 79481, episodes: 239 }],
]);

let dbLoaded = false;
let dbEntryCount = 0;
let nameCache = new Map();

function normalize(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[''""`]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractIds(sources) {
  let anilistId = null, anidbId = null, malId = null, kitsuId = null;
  for (const src of sources || []) {
    if (!anilistId) { const m = src.match(/anilist\.co\/anime\/(\d+)/); if (m) anilistId = parseInt(m[1]); }
    if (!anidbId) { const m = src.match(/anidb\.net\/anime\/(\d+)/); if (m) anidbId = parseInt(m[1]); }
    if (!malId) { const m = src.match(/myanimelist\.net\/anime\/(\d+)/); if (m) malId = parseInt(m[1]); }
    if (!kitsuId) { const m = src.match(/kitsu\.app\/anime\/(\d+)/); if (m) kitsuId = parseInt(m[1]); }
  }
  return { anilistId, anidbId, malId, kitsuId };
}

function buildIndexes(data) {
  titleIndex.clear(); anilistIndex.clear(); anidbIndex.clear(); malIndex.clear();

  for (const entry of data) {
    const ids = extractIds(entry.sources);
    if (!ids.anilistId) continue;
    const extraIds = ids.anidbId ? (animeListsIndex.get(ids.anidbId) || {}) : {};

    const record = {
      anilistId: ids.anilistId, anidbId: ids.anidbId, malId: ids.malId, kitsuId: ids.kitsuId,
      tvdbId: extraIds.tvdbId || null, tmdbId: extraIds.tmdbId || null, imdbId: extraIds.imdbId || null,
      tvdbSeason: extraIds.tvdbSeason != null ? extraIds.tvdbSeason : null,
      episodeOffset: extraIds.episodeOffset || 0,
      title: entry.title, type: entry.type, episodes: entry.episodes || 0, synonyms: entry.synonyms || [],
      year: entry.animeSeason?.year || null,
      // English title: find first synonym that looks English (ASCII-only, 3+ chars)
      titleEn: (entry.synonyms || []).find(s => s && s.length >= 3 && /^[a-zA-Z0-9\s:!?',.\-()&]+$/.test(s) && s !== entry.title) || null,
    };

    // Fix #95: apply per-AniList override (tvdb/imdb/tmdb/season) before indexing, so
    // getByAniListId + resolveByTitle return the corrected mapping for entries Fribb lacks.
    const _ov = ID_OVERRIDES.get(ids.anilistId);
    if (_ov) {
      if (_ov.tvdbId != null) record.tvdbId = _ov.tvdbId;
      if (_ov.tmdbId != null) record.tmdbId = _ov.tmdbId;
      if (_ov.imdbId != null) record.imdbId = _ov.imdbId;
      if (_ov.tvdbSeason != null) record.tvdbSeason = _ov.tvdbSeason;
    }

    anilistIndex.set(ids.anilistId, record);
    if (ids.anidbId) anidbIndex.set(ids.anidbId, record);
    if (ids.malId) malIndex.set(ids.malId, record);

    const allTitles = [entry.title, ...(entry.synonyms || [])];
    for (const t of allTitles) {
      const norm = normalize(t);
      if (norm.length < 2) continue;
      const existing = titleIndex.get(norm);
      if (!existing) {
        // First entry — store directly
        titleIndex.set(norm, record);
      } else if (Array.isArray(existing)) {
        // Already multi — add to array
        existing.push(record);
      } else if (existing.anilistId !== record.anilistId) {
        // Different anime with same name — convert to array
        titleIndex.set(norm, [existing, record]);
      }
    }
  }

  dbEntryCount = data.length;
  const withTvdb = [...anilistIndex.values()].filter(r => r.tvdbId).length;
  console.log(`  📚 Indexed: ${anilistIndex.size} AniList, ${anidbIndex.size} AniDB, ${titleIndex.size} titles, ${withTvdb} TVDB`);

  // Build episode offset table: tvdbId → sorted array of { season, anidbId, anilistId, offset, episodes }
  tvdbOffsetTable.clear();
  for (const [anidbId, alEntry] of animeListsIndex) {
    if (!alEntry.tvdbId || alEntry.tvdbSeason == null || alEntry.tvdbSeason < 1) continue;
    const record = anidbIndex.get(anidbId);
    if (!record || !record.episodes || record.episodes < 1) continue;

    const tvdbId = alEntry.tvdbId;
    if (!tvdbOffsetTable.has(tvdbId)) tvdbOffsetTable.set(tvdbId, []);
    tvdbOffsetTable.get(tvdbId).push({
      season: alEntry.tvdbSeason,
      anidbId,
      anilistId: record.anilistId,
      episodes: record.episodes,
    });
  }

  // Sort by season and compute offsets
  let offsetCount = 0;
  for (const [tvdbId, seasons] of tvdbOffsetTable) {
    if (seasons.length < 2) { tvdbOffsetTable.delete(tvdbId); continue; }
    seasons.sort((a, b) => a.season - b.season);
    let offset = 0;
    for (const s of seasons) {
      s.offset = offset;
      offset += s.episodes;
    }
    offsetCount++;
  }
  console.log(`  📐 Episode offsets: ${offsetCount} multi-season series`);

  // Fix #95: register ID_OVERRIDES franchise members in the offset table so buildRecord's
  // isFranchiseMemberRelative path recognises them (the Fribb loop above never added them
  // because their anime-lists entry has no tvdb/season). Append — don't overwrite — to keep
  // any Fribb seasons already present for the same tvdbId, then re-sort + recompute offsets.
  for (const [alId, ov] of ID_OVERRIDES) {
    if (!ov.tvdbId || ov.tvdbSeason == null) continue;
    const rec = anilistIndex.get(alId);
    if (!rec) continue;
    if (!tvdbOffsetTable.has(ov.tvdbId)) tvdbOffsetTable.set(ov.tvdbId, []);
    const seasons = tvdbOffsetTable.get(ov.tvdbId);
    if (!seasons.some(s => s.anilistId === alId)) {
      seasons.push({ season: ov.tvdbSeason, anidbId: rec.anidbId || null, anilistId: alId, episodes: ov.episodes || rec.episodes || 0 });
    }
    seasons.sort((a, b) => a.season - b.season);
    let off = 0;
    for (const s of seasons) { s.offset = off; off += s.episodes; }
  }
}

// Load manual season offsets from DB into tvdbOffsetTable
function loadManualOffsets(manualOffsets) {
  let count = 0;
  for (const mo of manualOffsets) {
    const seasons = mo.season_data;
    if (!Array.isArray(seasons) || seasons.length < 2) continue;
    const tvdbId = mo.tvdb_id || mo.tmdb_id || `manual_${mo.id}`;
    const subFranchise = !!mo.sub_franchise;
    seasons.sort((a, b) => a.season - b.season);
    let offset = 0;
    const entries = seasons.map(s => {
      const entry = { season: s.season, offset, episodes: s.episodes, anidbId: s.anidbId || null, anilistId: s.anilistId || null, subFranchise };
      offset += s.episodes;
      return entry;
    });
    tvdbOffsetTable.set(tvdbId, entries);
    count++;
  }
  if (count > 0) console.log(`  📐 Manual offsets: ${count} series`);
}

// Check if a TVDB ID is marked as sub_franchise (uploaders use sub-franchise DVD numbering
// like "Act II S2" where "S2" is the 2nd season of Act II subseries, not TVDB S2 aired).
// Used by buildRecord to apply franchiseSeason = tvdbSeason + parser.season - 1 calculation.
function isSubFranchiseTvdb(tvdbId) {
  if (!tvdbId) return false;
  const entries = tvdbOffsetTable.get(tvdbId);
  if (!entries || !entries.length) return false;
  return !!entries[0].subFranchise;
}

// For newly-released anime that don't yet have tvdbId in Manami dump (e.g. Spring 2026
// entries in a dump from the same week), search for their anilistId in sub_franchise
// offset tables. Returns { tvdbId, season } if found, null otherwise.
// This enables sub-franchise logic to fire even when resolved.tvdbId is null.
function findTvdbBySubFranchiseAnilist(anilistId) {
  if (!anilistId) return null;
  for (const [tvdbId, entries] of tvdbOffsetTable) {
    if (!entries || !entries.length || !entries[0].subFranchise) continue;
    const entry = entries.find(s => s.anilistId === anilistId);
    if (entry) return { tvdbId, season: entry.season };
  }
  return null;
}

// Fetch season data from TVDB API for series missing from anime-lists
const TVDB_API_KEY = process.env.TVDB_API_KEY || '';
let tvdbToken = null;
let tvdbTokenExpiry = 0;

async function getTvdbToken() {
  if (!TVDB_API_KEY) return null;
  if (tvdbToken && Date.now() < tvdbTokenExpiry) return tvdbToken;
  try {
    const resp = await axios.post('https://api4.thetvdb.com/v4/login', { apikey: TVDB_API_KEY }, { timeout: 10000 });
    tvdbToken = resp.data?.data?.token;
    tvdbTokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
    return tvdbToken;
  } catch (err) {
    console.log(`  ⚠️ TVDB login: ${err.message}`);
    return null;
  }
}

async function fetchTvdbSeasons(tvdbId) {
  const token = await getTvdbToken();
  if (!token) return null;
  try {
    const seasonMap = new Map();
    // Fetch pages until empty (TVDB returns 500 eps per page)
    for (let page = 0; page < 10; page++) {
      const resp = await axios.get(`https://api4.thetvdb.com/v4/series/${tvdbId}/episodes/default?page=${page}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      });
      const episodes = resp.data?.data?.episodes || [];
      if (!episodes.length) break;
      for (const ep of episodes) {
        const s = ep.seasonNumber;
        if (s == null || s < 1) continue;
        seasonMap.set(s, (seasonMap.get(s) || 0) + 1);
      }
      if (episodes.length < 500) break; // Last page
    }
    if (seasonMap.size < 2) return null;
    return [...seasonMap.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => ({ season, episodes }));
  } catch (err) {
    console.log(`  ⚠️ TVDB fetch ${tvdbId}: ${err.message}`);
    return null;
  }
}

// Fetch TMDB seasons for a series
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

async function fetchTmdbSeasons(tmdbId) {
  if (!TMDB_API_KEY) return null;
  try {
    const resp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`, { timeout: 10000 });
    const seasons = resp.data?.seasons;
    if (!seasons || seasons.length < 2) return null;
    return seasons
      .filter(s => s.season_number > 0 && s.episode_count > 0)
      .map(s => ({ season: s.season_number, episodes: s.episode_count }));
  } catch (err) {
    console.log(`  ⚠️ TMDB fetch ${tmdbId}: ${err.message}`);
    return null;
  }
}

// Cache for TVDB/TMDB API results — saved to disk
const API_CACHE_PATH = path.join(DATA_DIR, 'api-offsets-cache.json');
let apiOffsetsCache = new Map();

function loadApiCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(API_CACHE_PATH, 'utf8'));
    apiOffsetsCache = new Map(Object.entries(raw));
    console.log(`  💾 API offsets cache: ${apiOffsetsCache.size} entries`);
  } catch {}
}
function saveApiCache() {
  try { fs.writeFileSync(API_CACHE_PATH, JSON.stringify(Object.fromEntries(apiOffsetsCache)), 'utf8'); } catch {}
}

// Fill missing offsets from TVDB/TMDB API for long-running series
async function fillMissingOffsets() {
  if (!TVDB_API_KEY && !TMDB_API_KEY) return;
  loadApiCache();

  // Apply cached API results first (no API calls needed)
  let cachedCount = 0;
  for (const [key, seasons] of apiOffsetsCache) {
    if (tvdbOffsetTable.has(parseInt(key) || key)) continue;
    if (!Array.isArray(seasons) || seasons.length < 2) continue;
    let offset = 0;
    const entries = seasons.map(s => {
      const entry = { season: s.season, offset, episodes: s.episodes, anidbId: null, anilistId: null };
      offset += s.episodes;
      return entry;
    });
    tvdbOffsetTable.set(parseInt(key) || key, entries);
    cachedCount++;
  }
  if (cachedCount > 0) console.log(`  📐 Cached API offsets: ${cachedCount} series`);

  // Cross-lookup: fill in AniList IDs for API offset entries using tvdbSeason from anilistIndex
  let crossLinked = 0;
  for (const [tvdbId, seasons] of tvdbOffsetTable) {
    const needsIds = seasons.some(s => !s.anilistId);
    if (!needsIds) continue;
    // Find all AniList entries with this tvdbId
    for (const [alId, record] of anilistIndex) {
      if (record.tvdbId !== tvdbId) continue;
      const alEntry = animeListsIndex.get(record.anidbId);
      const tvdbSeason = alEntry?.tvdbSeason || record.tvdbSeason;
      if (!tvdbSeason) continue;
      const match = seasons.find(s => s.season === tvdbSeason && !s.anilistId);
      if (match) {
        match.anilistId = alId;
        match.anidbId = record.anidbId || null;
        crossLinked++;
      }
    }
  }
  if (crossLinked > 0) console.log(`  📐 Cross-linked: ${crossLinked} AniList IDs to API offsets`);

  // AniList LOCAL fallback: for offset entries still missing anilistId, search local DB only
  let localLinked = 0;
  for (const [tvdbId, seasons] of tvdbOffsetTable) {
    const missing = seasons.filter(s => !s.anilistId && s.season > 1);
    if (!missing.length) continue;
    const s1 = seasons.find(s => s.anilistId);
    let baseTitle = null;
    if (s1) {
      const rec = anilistIndex.get(s1.anilistId);
      if (rec) baseTitle = rec.title;
    }
    if (!baseTitle) {
      for (const [alId, rec] of anilistIndex) {
        if (rec.tvdbId === tvdbId) { baseTitle = rec.title; break; }
      }
    }
    if (!baseTitle) continue;
    // Fix #111a: base titul může být sequel záznam ("… Part 2") — dílčí regexy
    // ustřihly jen koncové číslo a nechaly viset "Part" → search "… Part 3rd Season"
    // je nesmysl a matchne špatnou sezónu. stripSeasonSuffix (Fix #107) stripuje
    // iterativně celé sufixy ("Part 2", "2nd Season", "II", …).
    const cleanBase = stripSeasonSuffix(baseTitle);

    for (const entry of missing) {
      const ordinal = entry.season === 2 ? '2nd' : entry.season === 3 ? '3rd' : `${entry.season}th`;
      const searchTerms = [
        `${cleanBase} ${ordinal} Season`,
        `${cleanBase} Season ${entry.season}`,
        `${cleanBase} ${entry.season}`,
      ];
      for (const term of searchTerms) {
        const local = resolveByTitle(term);
        if (local?.anilistId && !seasons.some(s => s.anilistId === local.anilistId)) {
          const localType = local.type || '';
          if (localType === 'MOVIE' || localType === 'OVA' || localType === 'SPECIAL') continue;
          entry.anilistId = local.anilistId;
          entry.anidbId = local.anidbId || null;
          localLinked++;
          break;
        }
      }
    }
  }
  if (localLinked > 0) console.log(`  📐 AniList offset IDs: ${localLinked} resolved (local)`);
}

// Online part — called during fetch cycle, uses shared AniList budget
async function fillMissingOffsetsOnline(maxApiCalls = 5) {
  if (isAnilistRateLimited()) return;
  const available = Math.min(anilistBudget, maxApiCalls);
  if (available <= 0) {
    console.log(`  📐 Offset lookups skipped — AniList budget exhausted`);
    return;
  }

  let apiLinked = 0;
  let rateLimited = false;
  for (const [tvdbId, seasons] of tvdbOffsetTable) {
    if (apiLinked >= available || rateLimited || isAnilistRateLimited()) break;
    const missing = seasons.filter(s => !s.anilistId && s.season > 1);
    if (!missing.length) continue;
    const s1 = seasons.find(s => s.anilistId);
    let baseTitle = null;
    if (s1) {
      const rec = anilistIndex.get(s1.anilistId);
      if (rec) baseTitle = rec.title;
    }
    if (!baseTitle) {
      for (const [alId, rec] of anilistIndex) {
        if (rec.tvdbId === tvdbId) { baseTitle = rec.title; break; }
      }
    }
    if (!baseTitle) continue;
    // Fix #111a: base titul může být sequel záznam ("… Part 2") — dílčí regexy
    // ustřihly jen koncové číslo a nechaly viset "Part" → search "… Part 3rd Season"
    // je nesmysl a matchne špatnou sezónu. stripSeasonSuffix (Fix #107) stripuje
    // iterativně celé sufixy ("Part 2", "2nd Season", "II", …).
    const cleanBase = stripSeasonSuffix(baseTitle);

    for (const entry of missing) {
      if (apiLinked >= available || rateLimited || !consumeAnilistBudget()) break;

      // Skip if already failed 3+ times
      try {
        const { getFailedOffsetAttempts } = require('./database');
        const prev = getFailedOffsetAttempts(tvdbId, entry.season);
        if (prev && !prev.resolved && prev.attempts >= 3) continue;
      } catch {}

      const ordinal = entry.season === 2 ? '2nd' : entry.season === 3 ? '3rd' : `${entry.season}th`;
      try {
        const wait = 2000 - (Date.now() - anilistLastReq);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        anilistLastReq = Date.now();
        const resp = await axios.post('https://graphql.anilist.co', {
          query: `query($s:String){Media(search:$s,type:ANIME){id idMal format title{romaji}}}`,
          variables: { s: `${cleanBase} ${ordinal} Season` },
        }, { timeout: 10000 });
        const media = resp.data?.data?.Media;
        if (media?.id && !seasons.some(s => s.anilistId === media.id)) {
          const fmt = (media.format || '').toUpperCase();
          if (fmt === 'MOVIE' || fmt === 'OVA' || fmt === 'SPECIAL' || fmt === 'MUSIC') {
            console.log(`  ⚠️ Offset AniList: "${cleanBase}" S${entry.season} → AL ${media.id} "${media.title?.romaji}" (${fmt}) — skipped`);
            // Track in failed_offsets
            try {
              const { upsertFailedOffset } = require('./database');
              upsertFailedOffset({
                tvdbId, season: entry.season, baseTitle: cleanBase,
                foundAnilistId: media.id, foundTitle: media.title?.romaji,
                foundType: fmt, reason: `Found ${fmt} instead of TV`,
              });
            } catch {}
            continue;
          }
          entry.anilistId = media.id;
          console.log(`  🌐 Offset AniList: "${cleanBase}" S${entry.season} → AL ${media.id} "${media.title?.romaji}" [budget: ${anilistBudget}]`);
          apiLinked++;
        } else if (!media?.id) {
          // No result at all — track as failed
          try {
            const { upsertFailedOffset } = require('./database');
            upsertFailedOffset({
              tvdbId, season: entry.season, baseTitle: cleanBase,
              reason: 'No AniList result found',
            });
          } catch {}
        }
      } catch (err) {
        if (err.response?.status === 429) {
          setAnilistRateLimit(90);
          rateLimited = true;
          break;
        }
      }
    }
  }
  if (apiLinked > 0) console.log(`  📐 AniList offset IDs: ${apiLinked} resolved (online)`);

  // Find series with high episode count but no offset table — fetch from API
  let fetched = 0;
  for (const [anilistId, record] of anilistIndex) {
    if (record.episodes < 50) continue;
    if (record.tvdbId && tvdbOffsetTable.has(record.tvdbId)) continue;
    if (record.tmdbId && tvdbOffsetTable.has(record.tmdbId)) continue;
    
    // Try TVDB first, then TMDB
    let seasons = null;
    let cacheKey = null;
    if (TVDB_API_KEY && record.tvdbId) {
      cacheKey = String(record.tvdbId);
      if (!apiOffsetsCache.has(cacheKey)) {
        seasons = await fetchTvdbSeasons(record.tvdbId);
        if (seasons && seasons.length >= 2) {
          apiOffsetsCache.set(cacheKey, seasons);
          let offset = 0;
          const entries = seasons.map(s => {
            const entry = { season: s.season, offset, episodes: s.episodes, anidbId: null, anilistId };
            offset += s.episodes;
            return entry;
          });
          tvdbOffsetTable.set(record.tvdbId, entries);
          console.log(`  📐 TVDB API: ${record.title} → ${seasons.length} seasons`);
          fetched++;
        } else {
          apiOffsetsCache.set(cacheKey, []); // Negative cache
        }
      }
    }
    if (!seasons && TMDB_API_KEY && record.tmdbId) {
      cacheKey = String(record.tmdbId);
      if (!apiOffsetsCache.has(cacheKey)) {
        seasons = await fetchTmdbSeasons(record.tmdbId);
        if (seasons && seasons.length >= 2) {
          apiOffsetsCache.set(cacheKey, seasons);
          let offset = 0;
          const entries = seasons.map(s => {
            const entry = { season: s.season, offset, episodes: s.episodes, anidbId: null, anilistId };
            offset += s.episodes;
            return entry;
          });
          tvdbOffsetTable.set(record.tmdbId, entries);
          console.log(`  📐 TMDB API: ${record.title} → ${seasons.length} seasons`);
          fetched++;
        } else {
          apiOffsetsCache.set(cacheKey, []);
        }
      }
    }
    
    // Rate limit
    if (fetched > 0 && fetched % 5 === 0) await new Promise(r => setTimeout(r, 1000));
    if (fetched >= 20) break;
  }
  if (fetched > 0) {
    saveApiCache();
    console.log(`  📐 API offsets: ${fetched} new series (${apiOffsetsCache.size} total cached)`);
  }
}

async function downloadJSON(urls, destPath, label) {
  const urlList = Array.isArray(urls) ? urls : [urls];
  for (const url of urlList) {
    try {
      console.log(`  📥 ${label}: ${url.substring(0, 80)}...`);
      const resp = await axios.get(url, { timeout: 60000, maxContentLength: 150 * 1024 * 1024, maxRedirects: 5 });
      const jsonStr = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      fs.writeFileSync(destPath, jsonStr, 'utf8');
      console.log(`  ✅ ${label}: ${(Buffer.byteLength(jsonStr) / 1024 / 1024).toFixed(1)} MB`);
      return true;
    } catch (err) { console.log(`  ⚠️ ${label}: ${err.message}`); }
  }
  return false;
}

async function loadAnimeLists() {
  let need = true;
  try { if (Date.now() - fs.statSync(ANIMELISTS_PATH).mtimeMs < DB_MAX_AGE) need = false; } catch {}
  if (need) await downloadJSON(ANIMELISTS_URL, ANIMELISTS_PATH, 'Anime-Lists');
  try {
    const raw = JSON.parse(fs.readFileSync(ANIMELISTS_PATH, 'utf8'));
    animeListsIndex.clear();
    for (const e of (Array.isArray(raw) ? raw : [])) {
      if (!e.anidb_id) continue;
      // tmdb id: anime-lists.json switched from a scalar to an object form
      // ({ "tv": 12345 } or { "movie": 678 }). Normalize to a single integer —
      // prefer the TV id (anime are overwhelmingly series), fall back to movie.
      // Older entries may still be a bare number/string; handle both.
      let tmdbRaw = e.themoviedb_id ?? e.tmdb_id ?? null;
      let tmdbId = null;
      if (tmdbRaw && typeof tmdbRaw === 'object') {
        tmdbId = tmdbRaw.tv ?? tmdbRaw.movie ?? null;
      } else if (tmdbRaw != null) {
        tmdbId = parseInt(tmdbRaw) || null;
      }
      // Fix #94: Fribb anime-lists sometimes stores imdb_id (and rarely tvdb_id) as an
      // ARRAY, e.g. "imdb_id": ["tt39047437"]. Binding an array to SQLite throws
      // ("can only bind numbers, strings, bigints, buffers, and null"), which silently
      // broke every insert/update for such anime (Meitantei Precure, Digimon Beatbreak,
      // Beyblade X, Please Twins...). Normalize to the first scalar element.
      const _scalar = v => Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      animeListsIndex.set(e.anidb_id, {
        tvdbId: _scalar(e.tvdb_id || e.thetvdb_id) || null,
        tmdbId,
        imdbId: _scalar(e.imdb_id) || null,
        tvdbSeason: e.season?.tvdb != null ? parseInt(e.season.tvdb) : null,
        tmdbSeason: e.season?.tmdb != null ? parseInt(e.season.tmdb) : null,
        episodeOffset: e.episode_offset != null ? parseInt(e.episode_offset) : (e.episodeoffset != null ? parseInt(e.episodeoffset) : 0),
      });
    }
    console.log(`  🔗 Anime-Lists: ${animeListsIndex.size} mappings`);
  } catch (err) { console.log(`  ⚠️ Anime-Lists: ${err.message}`); }
}

async function loadDatabase() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try {
    if (fs.existsSync(CACHE_PATH)) {
      nameCache = new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))));
      console.log(`  💾 Name cache: ${nameCache.size} entries`);
    }
  } catch {}

  await loadAnimeLists();

  let need = true;
  try { if (Date.now() - fs.statSync(DB_PATH).mtimeMs < DB_MAX_AGE) need = false; } catch {}
  if (need) {
    const ok = await downloadJSON(MANAMI_URLS, DB_PATH, 'Manami DB');
    if (!ok && !fs.existsSync(DB_PATH)) { console.error('  ❌ No DB!'); dbLoaded = false; return; }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    buildIndexes(raw.data || []);
    dbLoaded = true;
    console.log(`  ✅ Offline DB: ${dbEntryCount} entries`);
  } catch (err) { console.error(`  ❌ Parse: ${err.message}`); dbLoaded = false; }

  // Fix #25: Load persisted 18+ entries into live indexes
  loadAdultCache();
}

// ===== TITLE PREPROCESSING — generate multiple search variants =====
function generateSearchVariants(title) {
  if (!title) return [];
  const variants = [];
  const norm = normalize(title);
  variants.push(norm);

  // 1. Extract parts from "Title (Alt Title)" or "Title | Alt Title"
  const parenMatch = title.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    variants.push(normalize(parenMatch[1]));
    variants.push(normalize(parenMatch[2]));
  }

  // 1a. Handle unclosed paren (anitomy ate closing paren): "Angels Egg (Tenshi no Tamago"
  if (!parenMatch) {
    const unclosedParenMatch = title.match(/^(.+?)\s*\(([^()]+)$/);
    if (unclosedParenMatch) {
      variants.push(normalize(unclosedParenMatch[1]));
      variants.push(normalize(unclosedParenMatch[2]));
    }
  }

  // 1b. Extract from pipe: "Title | Alt1 | Alt2"
  if (title.includes('|')) {
    const pipeParts = title.split('|').map(s => s.trim()).filter(s => s.length > 2);
    for (const p of pipeParts) {
      const pNorm = normalize(p);
      if (pNorm.length > 2) variants.push(pNorm);
    }
  }

  // Fix #30: Extract from slash separator: "Romaji / English" bilingual titles
  // Common in BD releases: "Jitsu wa Ore, Saikyou deshita? / Am I Actually the Strongest?"
  // The combined string doesn't match any DB entry, but each half usually does.
  // Only split when surrounded by whitespace to avoid breaking legitimate slashes
  // in titles like "AC/DC" or file paths. Splits on " / " with spaces.
  if (title.includes(' / ')) {
    const slashParts = title.split(/\s+\/\s+/).map(s => s.trim()).filter(s => s.length > 2);
    for (const p of slashParts) {
      const pNorm = normalize(p);
      if (pNorm.length > 2) variants.push(pNorm);
    }
  }

  // 1c. Extract from comma-separated alt names in parentheses: "(Name1, Name2)"
  const commaParenMatch = title.match(/\(([^)]+,\s*[^)]+)\)/);
  if (commaParenMatch) {
    const parts = commaParenMatch[1].split(',').map(s => s.trim());
    for (const p of parts) {
      const pNorm = normalize(p);
      if (pNorm.length > 2) variants.push(pNorm);
    }
  }

  // 2. Remove trailing season number: "Yami Shibai 16" → "Yami Shibai"
  const seasonNumMatch = norm.match(/^(.+?)\s+(\d{1,2})$/);
  if (seasonNumMatch && parseInt(seasonNumMatch[2]) <= 20) {
    variants.push(seasonNumMatch[1]);
  }

  // 3. Remove "season X" / "Xth season" / "part X" / "cour X"
  const cleaned = norm
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season/i, '')
    .replace(/\s+season\s+\d+/i, '')
    .replace(/\s+part\s+\d+/i, '')
    .replace(/\s+cour\s+\d+/i, '')
    .replace(/\s+s\d+$/, '')
    .trim();
  if (cleaned !== norm && cleaned.length > 2) variants.push(cleaned);

  // 4. Handle "X: Subtitle" → try just "X"
  const colonParts = norm.split(/\s*:\s*/);
  if (colonParts.length >= 2 && colonParts[0].length >= 3) {
    variants.push(colonParts[0]);
    // Also try "X Subtitle" without colon
    variants.push(colonParts.join(' '));
  }

  // 5. Handle " - Subtitle" → try just base
  const dashParts = norm.split(/\s+-\s+/);
  if (dashParts.length >= 2 && dashParts[0].length >= 3) {
    variants.push(dashParts[0]);
  }

  // 6. Remove common noise words
  const noNoise = norm
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (noNoise !== norm) variants.push(noNoise);

  // 7. Without JP particles
  const noParticles = norm
    .replace(/\b(no|na|wo|ga|wa|ni|de|to|mo|e)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (noParticles !== norm) variants.push(noParticles);

  // 8. Handle apostrophe variants: "Hell's" → "Hells"
  if (title.includes("'")) {
    variants.push(normalize(title.replace(/'/g, '')));
    variants.push(normalize(title.replace(/'/g, ' ')));
  }

  // 9. Roman numeral variants: "Title II" → "Title 2", "Title IV" → "Title 4"
  // Fix #55b: Chytá Roman numeral kdekoliv jako standalone slovo, ne jen na konci.
  // Před: "Douluo Dalu II - Soul Land 2" se přes regex /\s+II$/ nezachytilo
  //       (II je uprostřed před " - Soul Land 2") → resolver padl na S1.
  // Po:   "Douluo Dalu II - Soul Land 2" → varianta "Douluo Dalu 2 - Soul Land 2"
  //       (Roman → Arabic), AniList online search najde AL 137683.
  // Exclude standalone "V" — too ambiguous (could be subtitle like "V" in "GTO V")
  const romanMap = { 'ii': '2', 'iii': '3', 'iv': '4', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9' };
  // Match všechny výskyty Roman numerals jako standalone slova (s word boundaries)
  const romanRe = /\b(ii|iii|iv|vi|vii|viii|ix)\b/gi;
  const romanMatches = [...norm.matchAll(romanRe)];
  if (romanMatches.length > 0) {
    // Generate variantu kde všechny Roman numerals nahrazené Arabic číslem
    let arabicVariant = norm;
    for (const m of romanMatches) {
      const arabic = romanMap[m[1].toLowerCase()];
      if (arabic) {
        arabicVariant = arabicVariant.replace(new RegExp('\\b' + m[1] + '\\b', 'i'), arabic);
      }
    }
    if (arabicVariant !== norm) variants.push(arabicVariant);
    // Fallback: pro "Title II" (Roman na konci) přidat i variantu bez čísla — "Title"
    // (zachovat původní chování pro single-roman case na konci)
    const trailingRoman = norm.match(/\s+(ii|iii|iv|vi|vii|viii|ix)$/i);
    if (trailingRoman) {
      variants.push(norm.replace(/\s+(ii|iii|iv|vi|vii|viii|ix)$/i, '').trim());
    }
  }
  // Reverse: "Title 2" → "Title II" (number to roman) — zachovat existující behavior
  const arabicMatch = norm.match(/\s+(\d)$/);
  if (arabicMatch) {
    const reverseRoman = { '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v', '6': 'vi', '7': 'vii', '8': 'viii', '9': 'ix' };
    const roman = reverseRoman[arabicMatch[1]];
    if (roman) variants.push(norm.replace(/\s+\d$/, ' ' + roman));
  }

  // 10. CamelCase / merged word splitting: "rezero" → "re zero", "danmachi" → "dan machi"
  // Parser sometimes strips : or - that separated words, creating merged tokens
  // Split on lowercase→uppercase boundary in ORIGINAL title, then normalize
  const camelSplit = title.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (camelSplit !== title) {
    const camelNorm = normalize(camelSplit);
    if (camelNorm !== norm) variants.push(camelNorm);
  }
  // Also try splitting on colon/dash that might have been in original: "Re:ZERO" → "Re ZERO"
  const colonDashSplit = title.replace(/:/g, ' ').replace(/(?<=[a-zA-Z])-(?=[A-Z])/g, ' ');
  if (colonDashSplit !== title) {
    const cdNorm = normalize(colonDashSplit);
    if (cdNorm !== norm && !variants.includes(cdNorm)) variants.push(cdNorm);
  }

  return [...new Set(variants)].filter(v => v.length > 1);
}

// Detect a sequel/season marker in a title (II, III, 2, 3, 2nd Season, Season 2, …).
// Used so a markerless query ("Clevatess") doesn't resolve to a sequel entry
// ("Clevatess II") when a base entry exists. Mirrors the fuzzy-path sequel reject.
const _SEQUEL_TOKEN_RE = /^(?:ii|iii|iv|vi|vii|viii|ix|2nd|3rd|[4-9]th|[2-9])$/i;
function titleHasSequelMarker(title) {
  if (!title) return false;
  const t = String(title).toLowerCase().replace(/[:\-_.~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bseason\s*[2-9]\b/.test(t) || /\b[2-9](?:nd|rd|th)\s+season\b/.test(t)) return true;
  return t.split(' ').some(w => _SEQUEL_TOKEN_RE.test(w));
}

// Pick best match from titleIndex entry (single record or array), considering year
function pickMatch(entry, year, typeHint, queryHasSequel) {
  if (!entry) return null;
  if (!Array.isArray(entry)) {
    // Single record — if year specified, check it matches (within 1 year tolerance)
    if (year && entry.year && Math.abs(entry.year - year) > 1) return null;
    return entry;
  }
  // Multiple records — filter by year first if provided
  let candidates = entry;
  if (year) {
    const yearMatches = candidates.filter(r => r.year && Math.abs(r.year - year) <= 1);
    if (yearMatches.length > 0) candidates = yearMatches;
    else return null; // No close year match
  }
  // If typeHint provided, prefer matching type
  if (typeHint && candidates.length > 1) {
    const typeMatches = candidates.filter(r => r.type === typeHint);
    if (typeMatches.length > 0) candidates = typeMatches;
  }
  // Sequel guard: a markerless query must not resolve to a sequel entry when a base
  // (non-sequel) candidate exists. "Clevatess" → "Clevatess" (S1, aired), not
  // "Clevatess II" (sequel, often UPCOMING/not-yet-aired). Inverse-symmetric to the
  // fuzzy-path reject. Only applies when it leaves ≥1 candidate (don't break sole-sequel).
  if (!queryHasSequel && candidates.length > 1) {
    const baseOnly = candidates.filter(r => !titleHasSequelMarker(r.title));
    if (baseOnly.length > 0 && baseOnly.length < candidates.length) candidates = baseOnly;
  }
  // Return record with most episodes (TV series over movies/specials)
  return candidates.reduce((best, r) => (!best || r.episodes > best.episodes) ? r : best, null);
}

// ===== RESOLVE BY TITLE — tries many variants =====
// Fix #77: Manual title overrides — manuální mapping pro tituly co fuzzy
// resolver pravidelně nezvládá. Klíč je normalizovaný title (lowercase,
// no punctuation), hodnota je AL ID.
//
// Tyto overrides mají **nejvyšší prioritu** — projdou před name cache,
// variants, fuzzy matching, AniList online API. Aplikace okamžitá.
//
// Případy v tabulce:
//   - Tituly s Roman + Arabic číslem ("II - 2") co fuzzy matchne na S1
//   - Tituly s alt. romanizací ("Douluo Dalu" vs "Toulou Dalu")
//   - Tituly co AniList API vrací false positives přes Media() single search
//
// Když najdeš nový problematický title, přidej entry zde + restart server.
const TITLE_OVERRIDES = new Map([
  // Soul Land 2 / Douluo Dalu II — fuzzy resolver matchoval na S1 (AL 101920)
  // místo správného AL 137683 (Soul Land 2: The Peerless Tang Clan, 156ep ONA)
  ['douluo dalu ii soul land 2', 137683],
  ['douluo dalu 2 soul land 2', 137683],
  ['soul land 2 the peerless tang clan', 137683],
  ['douluo dalu jueshi tangmen', 137683],
]);

// Fix #83: strip release/quality noise the parser left in a title, used as a
// LAST-RESORT retry inside resolveByTitle (only after every normal path missed),
// so it can add matches but never override a successful resolve.
// Deliberately conservative: leaves identity words like "Movie Edition" alone.
function stripReleaseNoise(title) {
  let t = String(title || '');
  // Embedded CJK alt-title — strip only when romaji remains (don't empty JP-only titles)
  const noCjk = t.replace(/[\u3040-\u30ff\u3400-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[A-Za-z]{2,}/.test(noCjk)) t = noCjk;
  t = t.replace(/_/g, ' ');                                          // Fix #87: underscore is a word char → breaks \b token boundaries
  t = t.replace(/\s+(?:Season\s*\d{1,2}|S\d{1,2})\b/gi, ' ');       // redundant season marker
  t = t.replace(/\b(?:HYBRID|Uncut|DOR|iTunes|Fansub|incomplete|Subs?|Multi|BD\s?Remux|BDRemux|BDRip|BD|DVDRip|WEBRip|WEB-?DL|HDTV|REMUX|UHD|2160p|1080p|720p|480p|HEVC|x26[45]|10-?bits?|DTS(?:-?HD(?:[. ]?MA)?)?|TrueHD|Dolby|Atmos|FLAC|AAC|AC3|Opus|PCM|Memorial|MKV|MP4|MPEG-?2)\b/gi, ' ');
  t = t.replace(/\b4K\b/g, ' ');
  t = t.replace(/\bv\d+\b/gi, ' ');                                  // version tag
  t = t.replace(/\b\d{1,4}\s*[-~]\s*\d{1,4}\b/g, ' ');             // Fix #87: episode range e.g. "0001-003"
  t = t.replace(/\b(?:19|20)\d{2}\b/g, ' ');                        // year
  t = t.replace(/\s+\d{1,4}\s*$/, ' ');                             // trailing leaked episode number
  t = t.replace(/[.\s]+/g, ' ').replace(/^[\s\-\u2013\u2014.]+|[\s\-\u2013\u2014.]+$/g, '').trim();
  return t;
}

function resolveByTitle(title, year, typeHint, _noStrip) {
  if (!title || !dbLoaded) return null;

  const norm = normalize(title);
  if (!norm) return null;

  // Sequel-marker status of the query — used to keep a markerless query from
  // resolving to a sequel entry (passed into pickMatch below).
  const _queryHasSequel = titleHasSequelMarker(title);

  // Fix #77: Manual override check — first priority
  if (TITLE_OVERRIDES.has(norm)) {
    const overrideId = TITLE_OVERRIDES.get(norm);
    const record = anilistIndex.get(overrideId);
    if (record) return record;
    // Override AL ID not in anilistIndex — return minimal stub
    return { anilistId: overrideId, tvdbId: null, title, type: typeHint || 'TV', episodes: 0 };
  }

  // Extract year from title if not provided: "Spice and Wolf (2008)" or "Title 2024"
  if (!year) {
    const yearInTitle = title.match(/\((\d{4})\)/);
    if (yearInTitle) year = parseInt(yearInTitle[1]);
    // Also try trailing year after removing from title
    if (!year) {
      const trailingYear = title.match(/\b((?:19|20)\d{2})\s*$/);
      if (trailingYear) year = parseInt(trailingYear[1]);
    }
  }

  // 1. Name cache
  // Cache is authoritative for the normalized title → anilist ID mapping.
  // When typeHint is provided, prefer matching type but still accept cache hits
  // (cached entry often is the canonical record; type mismatch falls through to variants).
  let typeMismatchCacheRecord = null; // fallback if variants find nothing
  if (!year && nameCache.has(norm)) {
    const cached = nameCache.get(norm);
    // Negative cache — old format (null) or new format ({failed: timestamp})
    if (cached === null && !typeHint) return null;
    if (cached?.failed) {
      // Expired after 24h → delete and allow retry
      if (Date.now() - cached.failed > 86400000) { nameCache.delete(norm); }
      else if (!typeHint) return null; // Still fresh → skip (only when no typeHint; with typeHint, retry via variants)
    }
    // TVDB-only cache entry (for 18+ titles not on AniList)
    if (typeof cached === 'string' && cached.startsWith('tvdb:')) {
      const tvdbId = parseInt(cached.slice(5));
      // Return minimal record with TVDB ID — enough for Stremio search
      return { anilistId: 0, tvdbId, title: title, type: 'TV', episodes: 0 };
    }
    if (typeof cached === 'number') {
      const record = anilistIndex.get(cached);
      if (record) {
        // Without typeHint: return the cached match directly.
        // With typeHint: only return if record.type matches (otherwise fall through to variants
        // which may find a better-typed entry). Missing record.type also treated as OK.
        if (!typeHint || !record.type || record.type.toUpperCase() === typeHint.toUpperCase()) {
          return record;
        }
        // Type mismatch — don't return yet, remember as fallback for end of function
        typeMismatchCacheRecord = record;
      } else {
        // Fix #24: Manual mapping points to an AL ID that's not yet in anilistIndex
        // (e.g. freshly-released anime like Spring 2026 shorts not yet in manami/fribb dump).
        // Return a minimal stub so buildRecord can still write the torrent with anilist_id set.
        // episodes=0 treated as "unknown" by downstream logic (epCountUnknown cases).
        return { anilistId: cached, title: title, type: typeHint || 'TV', episodes: 0 };
      }
    }
  }

  // 2. Generate all search variants
  const variants = generateSearchVariants(title);

  // 2b. If year provided, try "variant (year)" and "variant year" for all variants
  if (year) {
    for (const v of [norm, ...variants.slice(0, 5)]) {
      const yearVariants = [
        v + ' ' + year,
        v + ' (' + year + ')',
      ];
      for (const yv of yearVariants) {
        const match = pickMatch(titleIndex.get(yv), null, typeHint, _queryHasSequel);
        if (match) { nameCache.set(norm, match.anilistId); return match; }
      }
    }
  }

  // 3. Try exact match on each variant (with year filter)
  for (const v of variants) {
    const match = pickMatch(titleIndex.get(v), year, typeHint, _queryHasSequel);
    if (match) { nameCache.set(norm, match.anilistId); return match; }
  }

  // 3b. If year provided but no exact match: find via tvdbId — 
  // same franchise different year (e.g. "Pocket Monsters" 2023 → Pokemon (2023))
  if (year) {
    // First find any match without year to get tvdbId
    let anyMatch = null;
    for (const v of variants) {
      anyMatch = pickMatch(titleIndex.get(v), null, typeHint, _queryHasSequel);
      if (anyMatch?.tvdbId) break;
    }
    if (anyMatch?.tvdbId) {
      // Search all records with same tvdbId for year match
      for (const [alId, record] of anilistIndex) {
        if (record.tvdbId === anyMatch.tvdbId && record.year && Math.abs(record.year - year) <= 1) {
          nameCache.set(norm, record.anilistId);
          return record;
        }
      }
    }
    // Fallback: retry without year (better than nothing)
    for (const v of variants) {
      const match = pickMatch(titleIndex.get(v), null, typeHint, _queryHasSequel);
      if (match) {
        // Guard: caller gave a year but this is the no-year last resort. Don't accept
        // (and don't cache) a match whose KNOWN year is way off — that's a cross-era
        // same-title collision (e.g. "A Kite" 1998 release vs "Kite" 2020 entry).
        // Let it fall through to the online/TVDB fallback instead of poisoning the cache.
        if (year && match.year && Math.abs(match.year - year) > 5) continue;
        nameCache.set(norm, match.anilistId); return match;
      }
    }
  }

  // 4. Progressive substring — remove words from end (up to 5 words deep)
  // BUT skip if removed words contain sequel/season indicators (would match wrong series)
  const sequelIndicators = /^(?:ii|iii|iv|v|vi|vii|viii|ix|[2-9]|2nd|3rd|[4-9]th|s\d+)$/i;
  for (const v of variants.slice(0, 3)) {
    const words = v.split(' ');
    if (words.length >= 3) {
      for (let len = words.length - 1; len >= Math.max(2, words.length - 5); len--) {
        // Skip if substring is less than 60% of original words — too aggressive, false positives
        if (len / words.length < 0.6) break;
        // Check if any removed word is a sequel indicator
        const removed = words.slice(len);
        if (removed.some(w => sequelIndicators.test(w))) continue;
        const sub = words.slice(0, len).join(' ');
        const match = pickMatch(titleIndex.get(sub), year, typeHint, _queryHasSequel);
        if (match) { nameCache.set(norm, match.anilistId); return match; }
      }
    }
  }

  // 5. Fuzzy match
  // FIX #33: Fuzzy results are UNRELIABLE for new anime not yet in manami dump
  // (e.g. Spring 2026 "Monster Eater" AL 210234 was matched to 1982 "Lao Fu Zi
  // Shui Hu Chuan" AL 102294 via loose 2-word overlap). Fuzzy hits are returned
  // for THIS call but NOT cached — this lets online AniList fallback (called
  // by the fetcher pipeline when offline resolve returns weak/no match) correct
  // the mapping on retry. Also, if typeHint is set (parser detected TV/OVA/MOVIE
  // from filename), reject fuzzy candidates whose type disagrees — "S01E04" in
  // the torrent name implies TV, so a MOVIE fuzzy match is almost certainly wrong.
  for (const v of variants.slice(0, 3)) {
    const best = fuzzyMatch(v);
    if (best) {
      if (typeHint && best.type && best.type.toUpperCase() !== typeHint.toUpperCase()) {
        continue; // Type mismatch — fuzzy almost certainly wrong, try next variant
      }
      return best; // Return but DO NOT cache — let online retry correct it
    }
  }

  // 6. Fallback: if cache had a match but with different type, use it anyway
  // (better to return a related anime than nothing — season correction can then adjust)
  if (typeMismatchCacheRecord) return typeMismatchCacheRecord;

  // Fix #83: last-resort retry with release/quality noise stripped from the title.
  // Runs only after all paths above missed; _noStrip prevents recursion.
  if (!_noStrip) {
    // Fix #87: do NOT fallback-resolve multi-season / complete-collection packs.
    // They span several AniList IDs (e.g. "Kingdom Collection S1+S2+S3",
    // "Attack on Titan Series + Specials", "Inuyasha Seasons 1~7"), so a single-AL
    // match would mislabel the whole pack as one season. Leave them unresolved for
    // multi-AL/file-list handling or manual mapping instead.
    const isMultiPack = /\b(?:Complete|Collection)\b|Seasons?\s*\d+\s*[~&\-]\s*\d+|S\d+\s*\+\s*S?\d+|Series\s*\+\s*Specials/i.test(title);
    if (!isMultiPack) {
      const cleaned = stripReleaseNoise(title);
      if (cleaned && cleaned !== title && cleaned.length >= 2) {
        const retry = resolveByTitle(cleaned, year, typeHint, true);
        if (retry) return retry;
      }
    }
  }

  // No negative cache here — let AniList API try later
  return null;
}

// ===== Fuzzy matching =====
function fuzzyMatch(query) {
  if (!query || query.length < 3) return null;
  let bestMatch = null, bestScore = 0;
  const queryWords = new Set(query.split(' ').filter(w => w.length > 1));

  // Don't fuzzy match very short queries (1-2 words) — too many false positives
  if (queryWords.size < 2) return null;

  for (const [title, record] of titleIndex) {
    if (Math.abs(title.length - query.length) > query.length * 0.7) continue;
    const titleWords = new Set(title.split(' ').filter(w => w.length > 1));

    let overlap = 0;
    for (const qw of queryWords) {
      for (const tw of titleWords) {
        if (tw === qw || (tw.length >= 4 && qw.length >= 4 && Math.min(tw.length, qw.length) / Math.max(tw.length, qw.length) >= 0.85 && (tw.startsWith(qw) || qw.startsWith(tw)))) {
          overlap++; break;
        }
      }
    }

    // Require at least 2 overlapping words
    if (overlap < 2) continue;

    // Reject if query has a sequel indicator that the candidate lacks (or vice versa)
    // e.g. query "douluo dalu ii" should NOT fuzzy-match "douluo dalu" (different series)
    const seqRe = /\b(?:ii|iii|iv|vi|vii|viii|ix|[2-9]|2nd|3rd|[4-9]th)\b/;
    const queryHasSequel = seqRe.test(query);
    const titleHasSequel = seqRe.test(title);
    if (queryHasSequel !== titleHasSequel) continue;

    // Score: overlap ratio, but also penalize size mismatch
    // "Douluo Dalu II" (3 words) matching "Douluo Dalu" (2 words) should score lower
    // than matching "Douluo Dalu II" (3 words)
    const overlapRatio = overlap / Math.max(queryWords.size, titleWords.size);
    const sizePenalty = 1 - (Math.abs(queryWords.size - titleWords.size) * 0.15);
    const score = overlapRatio * Math.max(0.5, sizePenalty);
    
    if (score > 0.6 && score > bestScore) { bestScore = score; bestMatch = record; }

    // Substring containment — only for longer queries (3+ words)
    if (queryWords.size >= 3) {
      if (title.includes(query) || query.includes(title)) {
        const s = Math.min(query.length, title.length) / Math.max(query.length, title.length);
        if (s > 0.65 && s > bestScore) { bestScore = s; bestMatch = record; }
      }
    }
  }

  return bestMatch;
}

function resolveByAniDBId(id) { return anidbIndex.get(id) || null; }
function resolveByMALId(id) { return malIndex.get(id) || null; }
function getByAniListId(id) { return anilistIndex.get(id) || null; }

// Find anime by IMDB or TVDB ID (scans anilistIndex)
function findByImdbOrTvdb(imdbId, tvdbId) {
  if (!imdbId && !tvdbId) return null;
  for (const [alId, record] of anilistIndex) {
    if (imdbId && record.imdbId === imdbId) return record;
    if (tvdbId && record.tvdbId === tvdbId) return record;
  }
  return null;
}

// ===== AniList API fallback =====
let anilistLastReq = 0;
let anilistRateLimitUntil = 0; // Global cooldown — no AniList calls until this timestamp
let anilistBudget = 0;         // Remaining API calls for current cycle
let anilistBudgetResetAt = 0;  // When budget resets

function isAnilistRateLimited() {
  return Date.now() < anilistRateLimitUntil;
}

function setAnilistRateLimit(seconds = 90) {
  // Fix #23: Log only when transitioning to rate-limited state. Multiple
  // concurrent AniList requests (resolveByTitleOnline + fillMissingOffsetsOnline
  // running in parallel) can each receive 429 within the same fraction of a
  // second, each calling setAnilistRateLimit(90). Previously this logged the
  // "⚠️ AniList rate limited" line N times. Now log only on the first call
  // that actually sets the cooldown (or extends it) — subsequent duplicate
  // calls during an active rate-limit window are silent.
  const now = Date.now();
  const wasActive = now < anilistRateLimitUntil;
  anilistRateLimitUntil = now + seconds * 1000;
  anilistBudget = 0;
  if (!wasActive) {
    console.log(`  ⚠️ AniList rate limited — pausing all API calls for ${seconds}s`);
  }
}

// Budget system: call at start of each fetch cycle
// Night (23-06 UTC) gets bigger budget since less traffic
function resetAnilistBudget() {
  const hour = new Date().getUTCHours();
  const isNight = hour >= 21 || hour < 6; // ~22:00-07:00 CET
  anilistBudget = isNight ? 80 : 50;
  anilistBudgetResetAt = Date.now();
  return anilistBudget;
}

function consumeAnilistBudget() {
  if (anilistBudget <= 0) return false;
  anilistBudget--;
  return true;
}

function getAnilistBudget() { return anilistBudget; }

// ===== Fix #25: Authenticated AniList fetch for 18+ anime =====
// Public AniList API silently filters isAdult=true entries. With an OAuth token
// those entries become visible. SeaDex indexes popular 18+ anime but without
// this fallback, getByAniListId() returns null (because manami/fribb dumps
// also filter adult titles) and fetchSeaDex would write meaningless names
// like "[YURI] SeaDex (1080p BD x265) [15 files]" to the DB.
//
// Strategy:
// 1. Check env for ANILIST_TOKEN (no token → function is a no-op).
// 2. Call GraphQL Media(id:$id) with Authorization header.
// 3. Map result to the same record shape as anilistIndex entries so downstream
//    code (buildRecord, SeaDex name construction, search) treats it identically.
// 4. Persist to disk (ADULT_CACHE_PATH) so restarts don't re-fetch known entries.
// 5. Insert into live anilistIndex + titleIndex so subsequent resolveByTitle /
//    getByAniListId calls hit in-memory without touching the network.
//
// Shares the existing budget/rate-limit plumbing — no new quotas.

let adultCache = new Map(); // alId (number) → record

function loadAdultCache() {
  try {
    if (!fs.existsSync(ADULT_CACHE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(ADULT_CACHE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      const alId = parseInt(k);
      if (!alId || !v) continue;
      adultCache.set(alId, v);
      // Inject into live indexes so lookups hit immediately without fetch.
      anilistIndex.set(alId, v);
      if (v.malId) malIndex.set(v.malId, v);
      const norm = normalize(v.title);
      if (norm && !titleIndex.has(norm)) titleIndex.set(norm, v);
      for (const syn of (v.synonyms || [])) {
        const sn = normalize(syn);
        if (sn && !titleIndex.has(sn)) titleIndex.set(sn, v);
      }
    }
    if (adultCache.size) console.log(`  🔞 Adult cache: ${adultCache.size} entries loaded`);
  } catch (err) {
    console.log(`  ⚠️ Adult cache load: ${err.message}`);
  }
}

function saveAdultCache() {
  try {
    fs.writeFileSync(ADULT_CACHE_PATH, JSON.stringify(Object.fromEntries(adultCache)), 'utf8');
  } catch (err) {
    console.log(`  ⚠️ Adult cache save: ${err.message}`);
  }
}

// Returns record or null. Safe to call without token (no-op).
async function fetchAnilistByIdWithToken(alId) {
  if (!alId) return null;
  const token = process.env.ANILIST_TOKEN;
  if (!token) {
    console.log(`  🔞 AniList auth skip AL ${alId}: no ANILIST_TOKEN in env`);
    return null;
  }

  // Already cached in this session or from disk
  if (adultCache.has(alId)) {
    console.log(`  🔞 AniList auth AL ${alId}: hit adult cache`);
    return adultCache.get(alId);
  }
  const existing = anilistIndex.get(alId);
  if (existing && existing.title) {
    console.log(`  🔞 AniList auth skip AL ${alId}: already in anilistIndex as "${existing.title}"`);
    return existing; // normal dump already has it
  }

  if (isAnilistRateLimited()) {
    console.log(`  🔞 AniList auth skip AL ${alId}: rate limited`);
    return null;
  }
  if (anilistBudget <= 0) {
    console.log(`  🔞 AniList auth skip AL ${alId}: budget exhausted`);
    return null;
  }

  try {
    // Respect 2s minimum between AniList requests (same pattern as resolveByTitleOnline).
    const wait = 2000 - (Date.now() - anilistLastReq);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (!consumeAnilistBudget()) return null;
    anilistLastReq = Date.now();

    console.log(`  🔞 AniList auth calling API for AL ${alId}...`);
    const resp = await axios.post('https://graphql.anilist.co', {
      query: `query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english native} synonyms type format episodes isAdult seasonYear}}`,
      variables: { id: alId },
    }, {
      timeout: 10000,
      headers: { Authorization: `Bearer ${token}` },
    });

    const m = resp.data?.data?.Media;
    if (!m?.id) {
      console.log(`  🔞 AniList auth AL ${alId}: empty response (data=${JSON.stringify(resp.data).slice(0, 200)})`);
      return null;
    }

    // Fix #27: AniList's `type` field is ANIME/MANGA (meta-category). Manami DB
    // uses TV/MOVIE/OVA/ONA/SPECIAL which maps to AniList's `format` field.
    // Mapping: TV → TV, TV_SHORT → TV, MOVIE → MOVIE, OVA → OVA, ONA → ONA,
    // SPECIAL → SPECIAL, MUSIC → SPECIAL (rare). Fallback to TV for unknowns.
    const mappedType = ({
      TV: 'TV', TV_SHORT: 'TV', MOVIE: 'MOVIE', OVA: 'OVA',
      ONA: 'ONA', SPECIAL: 'SPECIAL', MUSIC: 'SPECIAL',
    })[m.format] || 'TV';

    // Note: animeListsIndex is keyed by anidb_id (not available via AniList API),
    // so for 18+ anime we typically won't have TVDB/IMDB mappings. That's fine —
    // SeaDex name construction only needs title/type/episodes. If user wants
    // TVDB binding for 18+ anime later, they can add it via manual offset table.
    const record = {
      anilistId: m.id,
      anidbId: null,
      malId: m.idMal || null,
      kitsuId: null,
      tvdbId: null,
      tmdbId: null,
      imdbId: null,
      tvdbSeason: null,
      episodeOffset: 0,
      title: m.title?.romaji || m.title?.english || m.title?.native || '',
      type: mappedType,
      episodes: m.episodes || 0,
      synonyms: [m.title?.english, m.title?.native, ...(m.synonyms || [])].filter(Boolean),
      year: m.seasonYear || null,
      titleEn: m.title?.english || null,
      isAdult: m.isAdult || false,
    };

    // Persist + insert into live indexes
    adultCache.set(m.id, record);
    saveAdultCache();
    anilistIndex.set(m.id, record);
    if (record.malId) malIndex.set(record.malId, record);
    const norm = normalize(record.title);
    if (norm && !titleIndex.has(norm)) titleIndex.set(norm, record);
    for (const syn of record.synonyms) {
      const sn = normalize(syn);
      if (sn && !titleIndex.has(sn)) titleIndex.set(sn, record);
    }

    console.log(`  🔞 AniList auth: AL ${m.id} → "${record.title}" (${record.type}, ${record.episodes} ep${record.isAdult ? ', 18+' : ''})`);
    return record;
  } catch (err) {
    if (err.response?.status === 429) { setAnilistRateLimit(90); return null; }
    if (err.response?.status === 404) return null;
    console.log(`  ❌ AniList auth: AL ${alId} → ${err.message}`);
    return null;
  }
}

// Fix #107: strip season/sequel sufixů z názvu série pro TMDB fallback.
// Iterativní — zvládne i řetězené sufixy ("Act II Second Season" → "Act" → base
// se stripne postupně). Pokrývá: číslicové ("Season 2", "Part 3", "Cour 2"),
// ordinální slovem ("2nd Season", "Second Season", "Third Season"...), římské
// ("II"–"IX"), japonské/anglické ("Saishuushou", "Final Season"), francouzské
// ("Saison 2"), a holé koncové číslo. Voláno JEN pro TV/série (ne filmy — tam je
// číslo součást identity filmu s vlastním imdb).
function stripSeasonSuffix(t) {
  let s = (t || '').trim();
  let prev = null;
  // Iteruj dokud se něco stripuje (max pár kol — bezpečné proti nekonečné smyčce).
  let guard = 0;
  while (s !== prev && guard++ < 6) {
    prev = s;
    s = s
      // "The Final Season" / "Final Season" (celé, i s "The" — musí být PŘED obecným Season)
      .replace(/\s*[:\-]?\s*(The\s+)?Final\s+Season$/i, '')
      .replace(/\s*[:\-]?\s*Saishuushou$/i, '')
      .replace(/\s*[:\-]?\s*(Season|Part|Cour|Saison)\s+\d+$/i, '')       // "Season 2", "Saison 2", ": Part 3"
      .replace(/\s*[:\-]?\s*\d+(st|nd|rd|th)\s+Season$/i, '')             // "2nd Season"
      .replace(/\s*[:\-]?\s*(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s+Season$/i, '')
      .replace(/\s*[:\-]?\s*(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+Season$/i, '') // "Second Season" slovem
      .replace(/\s+(II|III|IV|V|VI|VII|VIII|IX)$/i, '')                   // římské číslice
      .replace(/\s+[2-9]$/, '')                                          // holé koncové číslo
      .trim();
  }
  return s;
}

// Fix #107: dohledá imdb online z TMDB pro AL, které Fribb offline ještě nemá.
// Stripuje season/sequel sufixy ("2nd Season", "Part N", "Cour N", "II"...) —
// seriály jsou na TMDB pod základním názvem (sezóny = jen season number), takže
// plný název s sufixem TMDB nenajde. Vrací {imdbId, tmdbId, tvdbId} nebo null.
// Pořadí zkoušených názvů: en → romaji → stripnuté varianty obou (dedup).
async function enrichImdbFromTmdb(romajiTitle, enTitle, format) {
  if (!TMDB_API_KEY) return null;
  const isMovie = format === 'MOVIE';
  const searchEndpoint = isMovie ? 'search/movie' : 'search/tv';
  const extEndpoint = isMovie ? 'movie' : 'tv';
  const raw = [enTitle, romajiTitle].filter(Boolean);
  // Season/sequel strip aplikuj JEN pro seriály. U filmů je číslo součást identity
  // filmu ("Detective Conan Movie 5", "Pokemon Movie 3", "Kizumonogatari III" =
  // konkrétní film s vlastním imdb) — stripnutí by našlo jiný/první film série.
  const stripped = isMovie ? [] : raw.map(stripSeasonSuffix).filter(Boolean);
  const candidates = [...new Set([...raw, ...stripped])];
  for (const q of candidates) {
    if (!q) continue;
    try {
      const resp = await axios.get(
        `https://api.themoviedb.org/3/${searchEndpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}`,
        { timeout: 10000 }
      );
      const hit = (resp.data?.results || [])[0];
      if (!hit) continue;
      const ext = await axios.get(
        `https://api.themoviedb.org/3/${extEndpoint}/${hit.id}/external_ids?api_key=${TMDB_API_KEY}`,
        { timeout: 10000 }
      );
      const imdbId = ext.data?.imdb_id || null;
      if (imdbId && imdbId.startsWith('tt')) {
        return { imdbId, tmdbId: hit.id, tvdbId: ext.data?.tvdb_id || null };
      }
    } catch { /* zkus další variantu */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function resolveByTitleOnline(title, season) {
  if (!title) return null;
  if (isAnilistRateLimited()) return null;
  if (anilistBudget <= 0) return null;

  // Check negative cache before spending budget
  // Fix #110b: season-specific cache klíč pro season>=2. Bez tohohle sdílí všechny
  // sezóny stejného titulu JEDEN cache záznam (klíč = jen normalize(title)), takže
  // první resolvnutá sezóna přepíše cache pro všechny → "Season 2" pak dostane
  // cache-hit AL "Season 3" atd. Season>=2 dostane suffix "|s<N>", base (S1/undefined)
  // zůstává bez suffixu (zpětná kompatibilita s existující cache).
  const norm = (season && season >= 2)
    ? normalize(title) + '|s' + season
    : normalize(title);
  const cached = nameCache.get(norm);
  if (cached) {
    // Already resolved or negative-cached
    if (typeof cached === 'number') {
      // Fix #107b: titul je v name cache jako AL id. Fribb getByAniListId ale
      // nemusí mít imdb (nové "2nd Season" série ještě nejsou v offline dumpu).
      // Bez tohohle by cache-hit vrátil null (Fribb nemá) a NIKDY nespustil
      // enrichment → série zůstane unresolved i po opravě. Proto i tady:
      // Fribb má imdb → vrať; Fribb nemá imdb → online TMDB enrichment.
      const fribbCached = getByAniListId(cached);
      const cachedResult = fribbCached
        ? { ...fribbCached, anilistId: cached }
        : { anilistId: cached, title };
      if (!cachedResult.imdbId && TMDB_API_KEY) {
        try {
          const enriched = await enrichImdbFromTmdb(
            (fribbCached && fribbCached.title) || title,
            (fribbCached && fribbCached.titleEn) || null,
            (fribbCached && fribbCached.type) || 'TV'
          );
          if (enriched?.imdbId) {
            cachedResult.imdbId = enriched.imdbId;
            if (!cachedResult.tmdbId) cachedResult.tmdbId = enriched.tmdbId || null;
            if (!cachedResult.tvdbId) cachedResult.tvdbId = enriched.tvdbId || null;
            console.log(`  🎬 TMDB imdb fallback (cache): AL ${cached} → ${enriched.imdbId}`);
          }
        } catch { /* ponech bez imdb, doplní Fribb později */ }
      }
      // Pokud Fribb nic nemá A TMDB nic nenašel, vrať null (jako dřív — nepřidávej
      // prázdný AL bez jakéhokoli mapování, ať to nezanáší DB neúplnými záznamy).
      if (!fribbCached && !cachedResult.imdbId) return null;
      return cachedResult;
    }
    if (typeof cached === 'string' && cached.startsWith('tvdb:')) return null;
    if (cached?.failed) {
      // 24h negative cache expiry
      if (Date.now() - cached.failed < 24 * 60 * 60 * 1000) return null;
    }
  }

  // Smart variants: original title + max 1 best variant (saves budget)
  const variants = generateSearchVariants(title);
  // Pick only the most different variant (skip near-duplicates of original)
  const origNorm = normalize(title);
  const bestVariant = variants.find(v => {
    const vn = typeof v === 'string' ? v : '';
    return vn.length > 2 && vn !== origNorm && Math.abs(vn.length - origNorm.length) > 2;
  });
  let searches = bestVariant ? [title, bestVariant] : [title];

  // Fix #110: season-aware resolve. Když název měl explicitní season marker (S03E01,
  // "Season 3"), parser dá season=N. Bez tohohle resolveByTitleOnline hledal jen holý
  // title → Fix #108 base guard vybral S1 AL, takže záznam skončil s AL S1 ale season=N
  // (nekonzistentní). Příklad: "Mushoku Tensei Jobless Reincarnation S03E01" → title
  // "Mushoku Tensei Jobless Reincarnation" season=3 → resolve dal AL108465 (S1) místo
  // AL178789 (S3). AniList má sezóny jako přímé záznamy ("... Season 3"), takže pro
  // season>=2 zkusíme "Title Season N" JAKO PRVNÍ (nejvyšší priorita). Když nenajde,
  // spadne na běžný title search (base guard). Relations-chain traversal je nespolehlivý
  // (Part 2 / Cour / OVA edges pletou počítání sezón), proto suffix search.
  if (season && season >= 2) {
    const seasonQuery = `${title} Season ${season}`;
    searches = [seasonQuery, ...searches];
  }

  for (const searchTerm of searches) {
    if (isAnilistRateLimited() || anilistBudget <= 0) return null;

    try {
      // 2s minimum between AniList requests (safe under 90/min = 1.5/req)
      const wait = 2000 - (Date.now() - anilistLastReq);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      if (!consumeAnilistBudget()) return null;
      anilistLastReq = Date.now();

      // Fix #28: Use ANILIST_TOKEN if available so 18+ titles resolve from
      // any source (Nyaa, Tosho, etc.), not just SeaDex. Public API silently
      // filters isAdult=true (returns Media: null), authenticated requests
      // honor the account's "display adult content" setting and return full
      // data. Token is optional — without it, behavior is identical to
      // before (public API only, 18+ titles fail to resolve by name).
      // Expanded query: also pull type/format/episodes/isAdult so we can
      // build a complete record for 18+ anime (missing from manami dump).
      const headers = process.env.ANILIST_TOKEN
        ? { Authorization: `Bearer ${process.env.ANILIST_TOKEN}` }
        : {};

      // Fix #55d: Použít Page() query místo Media() (single).
      // Důvod: Media() vrací 1 best match podle AniList relevance algoritmu, který je
      // špatný pro sequels — např. pro "Douluo Dalu 2" vrátí AL 103543 (Jingying Sai)
      // místo AL 137683 (Soul Land 2 - Jueshi Tangmen). S Page(perPage:8) dostaneme
      // top 8 kandidátů a sami vybereme podle title match + sequel indicator.
      const resp = await axios.post('https://graphql.anilist.co', {
        query: `query($s:String){Page(perPage:8){media(search:$s,type:ANIME){id idMal title{romaji english native} synonyms type format episodes isAdult seasonYear}}}`,
        variables: { s: searchTerm },
      }, { timeout: 10000, headers });

      const candidates = resp.data?.data?.Page?.media || [];
      let media = null;

      if (candidates.length > 0) {
        // Scoring — pick best match. Priorita:
        // 1. Sequel indicator match (query "II"/"2" → candidate s "II"/"2")
        // 2. Title overlap (query words in title)
        // 3. Default: first candidate (AniList default order)
        const queryNorm = normalize(searchTerm);
        const queryWords = new Set(queryNorm.split(' ').filter(w => w.length > 1));
        const sequelRe = /\b(?:ii|iii|iv|vi|vii|viii|ix|[2-9])\b/;
        const queryHasSequel = sequelRe.test(queryNorm);
        // Extract sequel digit/roman z query: "douluo dalu 2" → "2"
        const querySequelMatch = queryNorm.match(sequelRe);
        const querySequel = querySequelMatch ? querySequelMatch[0].toLowerCase() : null;
        const romanToArabic = { 'ii': '2', 'iii': '3', 'iv': '4', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9' };
        const arabicToRoman = { '2': 'ii', '3': 'iii', '4': 'iv', '6': 'vi', '7': 'vii', '8': 'viii', '9': 'ix' };
        const queryArabic = querySequel ? (romanToArabic[querySequel] || querySequel) : null;
        const queryRoman = querySequel ? (arabicToRoman[querySequel] || querySequel) : null;

        let bestScore = -1, bestCandidate = candidates[0];
        let bestOverlap = 0; // Fix #116: word-overlap vítěze (bez sequel bonusů/penalt)
        for (const c of candidates) {
          const allTitles = [c.title?.romaji, c.title?.english, c.title?.native, ...(c.synonyms || [])]
            .filter(Boolean).map(t => normalize(t));

          let candOverlap = 0;
          // Word overlap
          for (const t of allTitles) {
            const tWords = new Set(t.split(' ').filter(w => w.length > 1));
            let overlap = 0;
            for (const qw of queryWords) if (tWords.has(qw)) overlap++;
            candOverlap = Math.max(candOverlap, overlap);
          }
          let score = candOverlap;

          // Sequel match boost — pokud query má "2" / "II", candidate musí taky mít
          if (queryHasSequel) {
            const candidateHasSequel = allTitles.some(t =>
              new RegExp('\\b' + queryArabic + '\\b').test(t) ||
              new RegExp('\\b' + queryRoman + '\\b').test(t)
            );
            if (candidateHasSequel) score += 5; // velký boost pro sequel match
            else score -= 3; // penalizace pokud sequel chybí (asi je to S1/related, ne náš sequel)
          } else {
            // Fix #108: inverzní guard — query NEMÁ sequel marker (base název jako
            // "Mushoku Tensei"), takže preferuj BASE záznam (S1), ne sequel.
            // Bez tohohle scoring skončí na candidates[0] = nejpopulárnější/nejnovější
            // sezóna (často S2/S3), protože word-overlap je stejný pro všechny sezóny.
            // Příklad chyby: "Mushoku Tensei - S01" batch dostal AL146065 (Season 2).
            // Penalizuj kandidáty, jejichž titul obsahuje season/sequel marker
            // (Season N / 2nd Season / II-IX / trailing digit), aby vyhrál base S1.
            const candidateIsSequel = allTitles.some(t =>
              /\bseason\s*[2-9]\b/.test(t) ||
              /\b[2-9](?:nd|rd|th)\s+season\b/.test(t) ||
              /\b(?:ii|iii|iv|vi|vii|viii|ix)\b/.test(t) ||
              /\b(?:part|cour)\s*[2-9]\b/.test(t) ||
              /\s[2-9]$/.test(t)
            );
            if (candidateIsSequel) score -= 3; // base query nemá chtít sequel záznam
          }

          if (score > bestScore) {
            bestScore = score;
            bestCandidate = c;
            bestOverlap = candOverlap;
          }
        }
        media = bestCandidate;

        // Fix #116: minimální důkaz shody. Když vítěz nesdílí s dotazem ANI JEDNO
        // slovo (v žádném titulu/synonymu), je to jen "první výsledek AniList
        // relevance" — ta matchuje i přes skrytý CN alt-index, který přes API
        // nevidíme, takže shodu nelze ověřit. Bývá to ÚPLNĚ jiná série.
        // Trigger: "Crowned in a Hundred Days" → AL199431 "Bai Ri Cheng Cai"
        // (nulový překryv; správný AL213484 tehdy v searchi chyběl) — výsledek
        // se zacachoval a otrávil 26 torrentů. Radši vrať null → torrent zůstane
        // unresolved a pozdější retry (až AniList doplní správný záznam) to srovná.
        // Guard queryWords.size > 0: CJK-only dotazy mají po normalize prázdná
        // slova — tam overlap ověřit nejde, chovej se jako dřív.
        if (bestOverlap === 0 && queryWords.size > 0) {
          console.log(`  ⛔ AniList: "${searchTerm}" → vítěz AL ${bestCandidate?.id} "${bestCandidate?.title?.romaji || '?'}" nesdílí ani slovo — odmítnuto (Fix #116) [budget: ${anilistBudget}]`);
          media = null;
        }
      }

      if (media?.id) {
        nameCache.set(norm, media.id);
        const vNorm = normalize(searchTerm);
        if (vNorm !== norm) nameCache.set(vNorm, media.id);
        saveNameCache();

        // Fix #28: If this is an 18+ anime (present only via token), persist
        // a full record to adult cache and insert into live indexes so
        // downstream code (buildRecord, SeaDex, search fallback) treats it
        // identically to manami entries. Non-adult hits skip this block —
        // they'll be served from manami on next startup anyway.
        if (media.isAdult && !anilistIndex.has(media.id)) {
          const mappedType = ({
            TV: 'TV', TV_SHORT: 'TV', MOVIE: 'MOVIE', OVA: 'OVA',
            ONA: 'ONA', SPECIAL: 'SPECIAL', MUSIC: 'SPECIAL',
          })[media.format] || 'TV';
          const record = {
            anilistId: media.id,
            anidbId: null,
            malId: media.idMal || null,
            kitsuId: null,
            tvdbId: null, tmdbId: null, imdbId: null,
            tvdbSeason: null, episodeOffset: 0,
            title: media.title?.romaji || media.title?.english || media.title?.native || title,
            type: mappedType,
            episodes: media.episodes || 0,
            synonyms: [media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean),
            year: media.seasonYear || null,
            titleEn: media.title?.english || null,
            isAdult: true,
          };
          adultCache.set(media.id, record);
          saveAdultCache();
          anilistIndex.set(media.id, record);
          if (record.malId) malIndex.set(record.malId, record);
          const recNorm = normalize(record.title);
          if (recNorm && !titleIndex.has(recNorm)) titleIndex.set(recNorm, record);
          for (const syn of record.synonyms) {
            const sn = normalize(syn);
            if (sn && !titleIndex.has(sn)) titleIndex.set(sn, record);
          }
          console.log(`  🔞 AniList (search): "${searchTerm}" → AL ${media.id} "${record.title}" (${record.type}, ${record.episodes} ep, 18+) [budget: ${anilistBudget}]`);
          return record;
        }

        console.log(`  🌐 AniList: "${searchTerm}" → AL ${media.id} "${media.title?.romaji}" [budget: ${anilistBudget}]`);
        // Fix #107: AniList našel AL, ale return měl jen {anilistId,malId,title} —
        // bez imdb/tvdb/tmdb. Nové "2nd Season" série (co ještě nejsou ve Fribb
        // offline dumpu) se pak vkládaly BEZ imdb → zůstaly ve unresolved seznamu.
        // Řešení: obohatit výsledek — (1) zkusit Fribb getByAniListId (možná už
        // má imdb z jiné cesty), (2) pokud ne, dohledat imdb online přes TMDB se
        // stripnutým názvem (2nd Season → base) + season number. Až se Fribb
        // offline tabulka doplní, převezme ji buildRecord přirozeně.
        const baseResult = { anilistId: media.id, malId: media.idMal, title: media.title?.romaji || title };
        // (1) Fribb offline lookup
        const fribb = getByAniListId(media.id);
        if (fribb) {
          baseResult.tvdbId = fribb.tvdbId || null;
          baseResult.tmdbId = fribb.tmdbId || null;
          baseResult.imdbId = fribb.imdbId || null;
          baseResult.kitsuId = fribb.kitsuId || null;
        }
        // (2) Fribb nemá imdb → online TMDB dohledání se stripováním sufixů
        if (!baseResult.imdbId && TMDB_API_KEY) {
          try {
            const enriched = await enrichImdbFromTmdb(
              media.title?.romaji || title,
              media.title?.english || null,
              media.format || 'TV'
            );
            if (enriched?.imdbId) {
              baseResult.imdbId = enriched.imdbId;
              if (!baseResult.tmdbId) baseResult.tmdbId = enriched.tmdbId || null;
              if (!baseResult.tvdbId) baseResult.tvdbId = enriched.tvdbId || null;
              console.log(`  🎬 TMDB imdb fallback: AL ${media.id} → ${enriched.imdbId} (Fribb ještě nemá)`);
            }
          } catch (e) { /* TMDB selhal — vlož aspoň s AL, imdb doplní Fribb později */ }
        }
        return baseResult;
      }
    } catch (err) {
      if (err.response?.status === 429) {
        setAnilistRateLimit(90);
        return null;
      }
      if (err.response?.status === 404 || err.response?.status === 400) continue;
      console.log(`  ❌ AniList: "${searchTerm}" → ${err.message}`);
      break;
    }
    // 2s between variant attempts
    await new Promise(r => setTimeout(r, 2000));
  }

  // AniList failed — try TVDB search as last resort (catches 18+/NSFW titles)
  const tvdbResult = await searchTvdb(title);
  if (tvdbResult) {
    nameCache.set(norm, `tvdb:${tvdbResult.tvdbId}`);
    saveNameCache();
    return tvdbResult;
  }

  // Negative cache with timestamp — will retry after 24h
  nameCache.set(norm, { failed: Date.now() });
  saveNameCache();
  return null;
}

// ===== TVDB API search fallback (for 18+ titles not on AniList) =====
let tvdbSearchLastReq = 0;
async function searchTvdb(title) {
  if (!TVDB_API_KEY || !title) return null;
  const token = await getTvdbToken();
  if (!token) return null;

  const wait = 1000 - (Date.now() - tvdbSearchLastReq);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const variants = [title, ...generateSearchVariants(title).slice(0, 2)];
  
  for (const searchTerm of variants) {
    try {
      tvdbSearchLastReq = Date.now();
      const resp = await axios.get('https://api4.thetvdb.com/v4/search', {
        params: { query: searchTerm, type: 'series', limit: 5 },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });

      const results = resp.data?.data || [];
      for (const r of results) {
        // Match: check if result name or any alias/translation is similar enough
        const queryNorm = normalize(searchTerm);
        if (!queryNorm) continue;
        
        // Collect all possible names from TVDB result
        const candidateNames = [r.name, r.slug?.replace(/-/g, ' ')];
        // TVDB search results may include aliases and translations
        if (r.aliases) candidateNames.push(...r.aliases);
        if (r.translations) {
          if (r.translations.eng) candidateNames.push(r.translations.eng);
          if (r.translations.jpn) candidateNames.push(r.translations.jpn);
          // Check all translation values
          for (const lang of Object.values(r.translations)) {
            if (typeof lang === 'string') candidateNames.push(lang);
          }
        }
        if (r.overviews) {
          // Sometimes name is in overview translations
        }
        
        let similar = false;
        for (const name of candidateNames) {
          if (!name) continue;
          const nameNorm = normalize(name);
          if (!nameNorm) continue;
          if (nameNorm.includes(queryNorm) || queryNorm.includes(nameNorm) || nameNorm === queryNorm) {
            similar = true;
            break;
          }
        }
        
        // If only 1 result returned, trust TVDB search (query was specific enough)
        if (!similar && results.length === 1 && queryNorm.split(' ').length >= 2) {
          similar = true;
        }
        
        if (!similar) continue;

        const tvdbId = parseInt(r.tvdb_id || r.id) || null;
        if (!tvdbId) continue;

        // Try to find IMDB from extended info
        let imdbId = null;
        try {
          const detail = await axios.get(`https://api4.thetvdb.com/v4/series/${tvdbId}/extended`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
          });
          const remoteIds = detail.data?.data?.remoteIds || [];
          const imdbEntry = remoteIds.find(rid => rid.sourceName === 'IMDB');
          if (imdbEntry) imdbId = imdbEntry.id;
        } catch {}

        console.log(`  📺 TVDB: "${searchTerm}" → TVDB ${tvdbId} "${r.name}" (imdb: ${imdbId || 'none'})`);
        // Prefer English translation, then original search term, then TVDB name (may be Japanese)
        const engName = r.translations?.eng || r.aliases?.find(a => /^[a-zA-Z]/.test(a)) || null;
        const displayTitle = engName || title || r.name;
        return {
          anilistId: 0,
          anidbId: null,
          malId: null,
          kitsuId: null,
          tvdbId,
          tmdbId: null,
          imdbId,
          tvdbSeason: 1,
          episodeOffset: 0,
          title: displayTitle,
          type: 'TV',
          episodes: 0,
          synonyms: [],
          year: r.year ? parseInt(r.year) : null,
        };
      }
    } catch (err) {
      console.log(`  ⚠️ TVDB search: "${searchTerm}" → ${err.message}`);
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function saveNameCache() {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(nameCache)), 'utf8'); } catch {}
}

function setManualMapping(name, anilistId) {
  const norm = normalize(name);
  if (!norm) return false;
  nameCache.set(norm, anilistId);
  saveNameCache();
  // Also persist to SQLite (survives Coolify restarts / volume wipes)
  try {
    const { upsertManualNameMapping } = require('./database');
    upsertManualNameMapping(norm, anilistId, name);
  } catch (err) {
    // DB not initialized yet or function missing — swallow, file cache still works
  }
  return true;
}

// Load manual name mappings from SQLite into in-memory nameCache
// Called after loadDatabase() in server startup to restore mappings
// that may have been wiped if data/name-cache.json got reset (Coolify deploy).
function loadManualNameMappingsFromDb() {
  try {
    const { getAllManualNameMappings } = require('./database');
    const mappings = getAllManualNameMappings();
    let restored = 0;
    for (const m of mappings) {
      // Only restore if key is missing or differs — don't overwrite fresh cache entries
      if (!nameCache.has(m.normalized_name) || typeof nameCache.get(m.normalized_name) !== 'number') {
        nameCache.set(m.normalized_name, m.anilist_id);
        restored++;
      }
    }
    if (restored > 0) {
      saveNameCache();
      console.log(`  🔖 Manual mappings restored from DB: ${restored}/${mappings.length}`);
    } else if (mappings.length > 0) {
      console.log(`  🔖 Manual mappings in DB: ${mappings.length} (all already in cache)`);
    }
  } catch (err) {
    console.log(`  ⚠️ loadManualNameMappingsFromDb: ${err.message}`);
  }
}

function getStats() {
  return { loaded: dbLoaded, entries: dbEntryCount, anilistCount: anilistIndex.size,
    anidbCount: anidbIndex.size, titleCount: titleIndex.size,
    animeListsMappings: animeListsIndex.size, nameCacheCount: nameCache.size,
    tvdbOffsetSeries: tvdbOffsetTable.size };
}

// Convert absolute episode to season + relative episode using offset table
// Returns { season, episode, anilistId } or null if no mapping found
function absoluteToSeason(tvdbId, absoluteEp) {
  if (!tvdbId || !absoluteEp) return null;
  const seasons = tvdbOffsetTable.get(tvdbId);
  if (!seasons) return null;
  return _findInOffsetSeasons(seasons, absoluteEp);
}

// Lookup offset table by anilistId (for series without tvdbId — manual offsets)
function absoluteToSeasonByAnilistId(anilistId, absoluteEp) {
  if (!anilistId || !absoluteEp) return null;
  for (const [key, seasons] of tvdbOffsetTable) {
    if (seasons.some(s => s.anilistId === anilistId)) {
      return _findInOffsetSeasons(seasons, absoluteEp);
    }
  }
  return null;
}

function _findInOffsetSeasons(seasons, absoluteEp) {
  // Find which season this absolute episode falls into
  for (let i = seasons.length - 1; i >= 0; i--) {
    const s = seasons[i];
    if (absoluteEp > s.offset) {
      const relativeEp = absoluteEp - s.offset;
      // Sanity check: relative episode should be within season's episode count (with some tolerance)
      if (relativeEp <= s.episodes + 5) {
        return { season: s.season, episode: relativeEp, anilistId: s.anilistId, anidbId: s.anidbId };
      }
    }
  }
  return null;
}

// Return the offset-table seasons[] array that contains the given anilistId, or null.
// Used by parseFileListEpisodes as a guard for the franchise-absolute file-list remap
// (>= 2 seasons = franchise registered in the offset table). Must NEVER throw — returns
// null for unregistered IDs so the caller treats it as a no-op.
function getOffsetSeasonsByAnilistId(anilistId) {
  if (!anilistId) return null;
  try {
    for (const [, seasons] of tvdbOffsetTable) {
      if (Array.isArray(seasons) && seasons.some(s => s.anilistId === anilistId)) return seasons;
    }
  } catch { /* offset table not ready — treat as unregistered */ }
  return null;
}

// Reverse lookup via Zenshin DB: (tvdbId | anilistId, tvdbSeason, tvdbEpisode) → tvdb_absolute
// Used as fallback when static offset tables don't have data (e.g. ongoing long-running anime
// like One Piece where per-season offsets aren't mapped in Fribb/manami but Zenshin has
// per-episode tvdb_absolute from AniDB+TVDB mapping).
// Safe: returns null on any error, never throws. Requires zenshin tables to be initialized.
//
// Fast path via zenshin.findAbsoluteEpisode() which uses composite index on
// (anidb_id, tvdb_season, tvdb_episode) — O(log n) instead of full JS scan.
function seasonToAbsoluteViaZenshin(tvdbId, anilistId, season, relativeEp) {
  if (season == null || !relativeEp) return null;
  if (!tvdbId && !anilistId) return null;
  try {
    const zenshin = require('./zenshin');
    if (!zenshin || typeof zenshin.findAbsoluteEpisode !== 'function') return null;
    return zenshin.findAbsoluteEpisode({ tvdbId, anilistId }, season, relativeEp) || null;
  } catch { /* zenshin not available or query failed — fall through to null */ }
  return null;
}

// Reverse: convert season + relative episode → absolute episode
// Tries static offset table first; falls back to Zenshin per-episode mapping.
function seasonToAbsolute(tvdbId, season, relativeEp) {
  if (!tvdbId || season == null || !relativeEp) return null;
  const seasons = tvdbOffsetTable.get(tvdbId);
  if (seasons) {
    const s = seasons.find(e => e.season === season);
    if (s) return s.offset + relativeEp;
  }
  // Fallback: Zenshin per-episode mapping (covers ongoing anime without Fribb offsets)
  return seasonToAbsoluteViaZenshin(tvdbId, null, season, relativeEp);
}

function seasonToAbsoluteByAnilistId(anilistId, season, relativeEp) {
  if (!anilistId || season == null || !relativeEp) return null;
  for (const [key, seasons] of tvdbOffsetTable) {
    if (seasons.some(s => s.anilistId === anilistId)) {
      const s = seasons.find(e => e.season === season);
      if (s) return s.offset + relativeEp;
    }
  }
  // Fallback: Zenshin per-episode mapping
  return seasonToAbsoluteViaZenshin(null, anilistId, season, relativeEp);
}

// Find anime record by tvdbId + tvdbSeason (scans anilistIndex)
// Used when offset table doesn't exist but parser found explicit SxxExx
function findByTvdbSeason(tvdbId, targetSeason) {
  if (!tvdbId || targetSeason == null) return null;
  for (const [alId, record] of anilistIndex) {
    if (record.tvdbId === tvdbId && record.tvdbSeason === targetSeason) return record;
  }
  return null;
}

// Get offset table for a TVDB ID (for debug/inspection)
function getTvdbOffsets(tvdbId) {
  return tvdbOffsetTable.get(tvdbId) || null;
}

// Force refresh — delete old files to trigger re-download, then reload
async function forceRefreshDatabase() {
  console.log('  🔄 Force refreshing offline databases...');
  const oldStats = { titles: titleIndex.size, anilist: anilistIndex.size };
  // Touch files to make them "old" so loadDatabase re-downloads
  try { fs.utimesSync(DB_PATH, new Date(0), new Date(0)); } catch {}
  try { fs.utimesSync(ANIMELISTS_PATH, new Date(0), new Date(0)); } catch {}
  await loadDatabase();
  const newStats = { titles: titleIndex.size, anilist: anilistIndex.size };
  console.log(`  ✅ DB refreshed: ${oldStats.anilist} → ${newStats.anilist} AniList, ${oldStats.titles} → ${newStats.titles} titles`);
}

// ===== Fill missing IMDB IDs from TMDB API =====
async function fillMissingImdbIds(db, limit = 20) {
  if (!TMDB_API_KEY) { console.log('  ⚠️ TMDB_API_KEY not set — skipping IMDB fill'); return { filled: 0, notFound: 0, errors: 0 }; }

  // Fix #113: attempt tracking s backoffem. Bez něj notFound záznamy (donghua
  // bez imdb na TMDB, ~200+ AL) zůstávaly imdb NULL a znovu vstupovaly do
  // SELECT … LIMIT (bez ORDER BY → stabilní pořadí, nejstarší první) při KAŽDÉM
  // běhu — trvale ucpaly frontu (daily limit 30 / weekly 50) a nové série se
  // na řadu nikdy nedostaly. Trigger: "Crowned in a Hundred Days" (AL199431)
  // měl na TMDB kompletní imdb/tvdb/tmdb, ale nikdy nebyl zpracován.
  // Backoff: <5 pokusů → retry po 1 dni; >=5 → retry po 7 dnech (TMDB imdb
  // u donghua časem přibývají, úplně vyřadit je nechceme). Nikdy nezkoušené
  // AL jdou první, pak nejstarší pokusy. Úspěch → řádek z trackingu smazán.
  db.exec(`CREATE TABLE IF NOT EXISTS imdb_fill_attempts (
    anilist_id INTEGER PRIMARY KEY,
    attempts INTEGER DEFAULT 0,
    last_attempt INTEGER
  )`);
  const _now = Math.floor(Date.now() / 1000);
  const _bumpAttempt = db.prepare(`INSERT INTO imdb_fill_attempts (anilist_id, attempts, last_attempt) VALUES (?, 1, ?)
    ON CONFLICT(anilist_id) DO UPDATE SET attempts = attempts + 1, last_attempt = excluded.last_attempt`);
  const _clearAttempt = db.prepare('DELETE FROM imdb_fill_attempts WHERE anilist_id = ?');

  // Find torrents with no imdb_id — try tvdb, tmdb, or title search
  const missing = db.prepare(`
    SELECT DISTINCT t.tvdb_id, t.tmdb_id, t.anilist_id, t.anime_title, t.anime_title_en, t.type
    FROM torrents t
    LEFT JOIN imdb_fill_attempts a ON a.anilist_id = t.anilist_id
    WHERE (t.imdb_id IS NULL OR t.imdb_id = '')
      AND t.anilist_id > 0
      AND (a.anilist_id IS NULL
        OR (a.attempts < 5 AND a.last_attempt < ${_now} - 86400)
        OR (a.attempts >= 5 AND a.last_attempt < ${_now} - 604800))
    ORDER BY (a.anilist_id IS NULL) DESC, a.last_attempt ASC
    LIMIT ?
  `).all(limit);

  if (!missing.length) { console.log('  ✅ No missing IMDB IDs (queue empty or backed off)'); return { filled: 0, notFound: 0, errors: 0 }; }

  console.log(`  🔍 TMDB: filling IMDB IDs for ${missing.length} anime...`);
  const stats = { filled: 0, notFound: 0, errors: 0 };

  const updateByTvdb = db.prepare('UPDATE torrents SET imdb_id = ?, tmdb_id = COALESCE(tmdb_id, ?) WHERE tvdb_id = ? AND (imdb_id IS NULL OR imdb_id = \'\')');
  const updateByTmdb = db.prepare('UPDATE torrents SET imdb_id = ? WHERE tmdb_id = ? AND (imdb_id IS NULL OR imdb_id = \'\')');
  const updateByAnilist = db.prepare('UPDATE torrents SET imdb_id = ?, tmdb_id = COALESCE(tmdb_id, ?), tvdb_id = COALESCE(tvdb_id, ?) WHERE anilist_id = ? AND (imdb_id IS NULL OR imdb_id = \'\')');

  for (const row of missing) {
    try {
      let imdbId = null, tmdbId = row.tmdb_id, tvdbId = row.tvdb_id;
      const isMovie = row.type === 'MOVIE';

      // Path 0: Check own DB — another record with same tvdb_id or base title already has IMDB
      if (row.tvdb_id) {
        const existing = db.prepare("SELECT imdb_id FROM torrents WHERE tvdb_id = ? AND imdb_id IS NOT NULL AND imdb_id != '' AND imdb_id NOT LIKE '~%' LIMIT 1").get(row.tvdb_id);
        if (existing?.imdb_id) imdbId = existing.imdb_id;
      }
      if (!imdbId) {
        // Strip season/sequel indicators from title: "Dorohedoro Season 2" → "Dorohedoro"
        const baseTitle = (row.anime_title || '')
          .replace(/\s+(Season|Part|Cour)\s+\d+$/i, '')
          .replace(/\s+\d+(st|nd|rd|th)\s+Season$/i, '')
          .replace(/\s+(II|III|IV|V|VI|VII|VIII|IX)$/i, '')
          .replace(/\s+[2-9]$/, '')
          .trim();
        if (baseTitle && baseTitle !== row.anime_title) {
          const existing = db.prepare("SELECT imdb_id FROM torrents WHERE anime_title = ? AND imdb_id IS NOT NULL AND imdb_id != '' AND imdb_id NOT LIKE '~%' LIMIT 1").get(baseTitle);
          if (existing?.imdb_id) imdbId = existing.imdb_id;
        }
      }

      if (imdbId && imdbId.startsWith('tt')) {
        updateByAnilist.run(imdbId, tmdbId, tvdbId, row.anilist_id);
        stats.filled++;
        _clearAttempt.run(row.anilist_id); // Fix #113
        console.log(`    ✅ ${row.anime_title} → ${imdbId} (from DB)`);
        continue;
      }
      imdbId = null;

      // Path 1: Have tvdb_id → use TMDB /find
      if (row.tvdb_id) {
        const resp = await axios.get(`https://api.themoviedb.org/3/find/${row.tvdb_id}?api_key=${TMDB_API_KEY}&external_source=tvdb_id`, { timeout: 10000 });
        const tvResults = resp.data?.tv_results || [];
        const movieResults = resp.data?.movie_results || [];

        if (tvResults.length > 0) {
          tmdbId = tmdbId || tvResults[0].id;
          const extResp = await axios.get(`https://api.themoviedb.org/3/tv/${tvResults[0].id}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 10000 });
          imdbId = extResp.data?.imdb_id || null;
        }
        if (!imdbId && movieResults.length > 0) {
          tmdbId = tmdbId || movieResults[0].id;
          const extResp = await axios.get(`https://api.themoviedb.org/3/movie/${movieResults[0].id}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 10000 });
          imdbId = extResp.data?.imdb_id || null;
        }
      }

      // Path 2: Have tmdb_id but no tvdb_id (or tvdb didn't work) → direct external_ids
      if (!imdbId && tmdbId) {
        const endpoint = isMovie ? 'movie' : 'tv';
        try {
          const extResp = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 10000 });
          imdbId = extResp.data?.imdb_id || null;
          if (!tvdbId) tvdbId = extResp.data?.tvdb_id || null;
        } catch {
          const altEndpoint = isMovie ? 'tv' : 'movie';
          try {
            const extResp = await axios.get(`https://api.themoviedb.org/3/${altEndpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 10000 });
            imdbId = extResp.data?.imdb_id || null;
            if (!tvdbId) tvdbId = extResp.data?.tvdb_id || null;
          } catch {}
        }
      }

      // Path 3: No tvdb_id, no tmdb_id → search TMDB by title
      // Only fill tvdb_id/tmdb_id, NOT imdb_id — title search may be inaccurate
      // IMDB will be filled on next run via Path 1/2, or manually
      if (!imdbId && !row.tvdb_id && !row.tmdb_id && row.anime_title) {
        const searchEndpoint = isMovie ? 'search/movie' : 'search/tv';
        // Fix #107: strip season/sequel sufixů i pro TMDB title search (Path 3).
        // Bez toho série jako "Hanazakari no Kimitachi e 2nd Season" nebo
        // "Sakamoto Days 2nd Season" zůstávaly unresolved, protože TMDB nemá
        // záznam s sufixem — seriál je veden pod základním názvem a sezóny jsou
        // jen season number. Zkoušíme plný název i stripnutou základní variantu.
        // Používá sdílenou stripSeasonSuffix (viz nahoře). Strip jen pro non-movie.
        const rawTitles = [row.anime_title_en, row.anime_title].filter(Boolean);
        const stripped = isMovie ? [] : rawTitles.map(stripSeasonSuffix).filter(Boolean);
        // Pořadí: nejdřív plné názvy (přesnější match), pak stripnuté základní.
        const titles = [...new Set([...rawTitles, ...stripped])];
        for (const title of titles) {
          if (tmdbId) break;
          try {
            const resp = await axios.get(`https://api.themoviedb.org/3/${searchEndpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`, { timeout: 10000 });
            const results = resp.data?.results || [];
            if (results.length > 0) {
              const best = results[0];
              tmdbId = best.id;
              const extEndpoint = isMovie ? 'movie' : 'tv';
              const extResp = await axios.get(`https://api.themoviedb.org/3/${extEndpoint}/${best.id}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 10000 });
              imdbId = extResp.data?.imdb_id || null;
              if (!tvdbId) tvdbId = extResp.data?.tvdb_id || null;
            }
          } catch {}
          await new Promise(r => setTimeout(r, 250));
        }
        if (tmdbId || tvdbId) {
          // Fill tvdb/tmdb IDs but mark imdb as needing review
          const foundImdb = imdbId;
          db.prepare('UPDATE torrents SET tmdb_id = COALESCE(tmdb_id, ?), tvdb_id = COALESCE(tvdb_id, ?) WHERE anilist_id = ?').run(tmdbId, tvdbId, row.anilist_id);
          if (foundImdb && foundImdb.startsWith('tt')) {
            // Store as candidate, not confirmed — prefix with ~ to mark as unverified
            db.prepare('UPDATE torrents SET imdb_id = ? WHERE anilist_id = ? AND (imdb_id IS NULL OR imdb_id = \'\')').run('~' + foundImdb, row.anilist_id);
            stats.filled++;
            _clearAttempt.run(row.anilist_id); // Fix #113 — ~kandidát opouští NULL frontu
            console.log(`    ⚠️ ${row.anime_title} → ~${foundImdb} (title search — needs review)`);
          } else {
            stats.notFound++;
            _bumpAttempt.run(row.anilist_id, _now); // Fix #113 — příště Path 1/2 přes nové tvdb/tmdb, s backoffem
            console.log(`    🔍 ${row.anime_title} → tmdb:${tmdbId} tvdb:${tvdbId} filled (no IMDB yet)`);
          }
          await new Promise(r => setTimeout(r, 250));
          continue;
        }
      }

      if (imdbId && imdbId.startsWith('tt')) {
        if (row.tvdb_id) {
          updateByTvdb.run(imdbId, tmdbId, row.tvdb_id);
        } else if (row.tmdb_id) {
          updateByTmdb.run(imdbId, row.tmdb_id);
        } else {
          // No original tvdb/tmdb — update by anilist_id, also fill tvdb/tmdb
          updateByAnilist.run(imdbId, tmdbId, tvdbId, row.anilist_id);
        }
        stats.filled++;
        _clearAttempt.run(row.anilist_id); // Fix #113
        console.log(`    ✅ ${row.anime_title} → ${imdbId}${!row.tvdb_id && !row.tmdb_id ? ' (title search)' : ''}`);
      } else {
        stats.notFound++;
        _bumpAttempt.run(row.anilist_id, _now); // Fix #113 — backoff, neucpávej frontu
        console.log(`    ❌ ${row.anime_title} (tvdb:${row.tvdb_id} tmdb:${tmdbId}) — no IMDB on TMDB`);
      }

      // Rate limit: ~250ms between requests
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      stats.errors++;
      console.log(`    ⚠️ ${row.anime_title}: ${err.message}`);
    }
  }

  console.log(`  📊 IMDB fill done: ${stats.filled} filled, ${stats.notFound} not found, ${stats.errors} errors`);
  return stats;
}

module.exports = {
  loadDatabase, resolveByTitle, resolveByAniDBId, resolveByMALId,
  getByAniListId, findByImdbOrTvdb, resolveByTitleOnline, setManualMapping, loadManualNameMappingsFromDb, saveNameCache,
  getStats, normalize, absoluteToSeason, absoluteToSeasonByAnilistId, getOffsetSeasonsByAnilistId, seasonToAbsolute, seasonToAbsoluteByAnilistId, seasonToAbsoluteViaZenshin, getTvdbOffsets, findByTvdbSeason, isSubFranchiseTvdb, findTvdbBySubFranchiseAnilist,
  loadManualOffsets, fillMissingOffsets, fillMissingOffsetsOnline,
  stripSeasonSuffix, // Fix #111a: sdílený season-suffix strip pro buildRecord season fallback
  isAnilistRateLimited, resetAnilistBudget, getAnilistBudget,
  fetchAnilistByIdWithToken,
  forceRefreshDatabase, fillMissingImdbIds,
  // Fix #77 helpers
  addTitleOverride: (title, anilistId) => TITLE_OVERRIDES.set(normalize(title), anilistId),
  removeTitleOverride: (title) => TITLE_OVERRIDES.delete(normalize(title)),
  getTitleOverrides: () => Object.fromEntries(TITLE_OVERRIDES),
};
