const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

// Searchable index of everything we have subtitles for.
//
// Built MANUALLY (POST /api/subs-index/build) — no cron on purpose while this is
// being tried out; `limit` lets you do a handful first. Source is /api/all from
// the subtitle service (~1150 anime), each entry resolved to an imdb id so
// Stremio can match it, enriched with the English title from Cinemeta (so
// "Frieren" finds "Sousou no Frieren") and given a poster carrying a CZ/SK tag.
//
// The poster art itself comes from Stremio's own MetaHub CDN (no key, the
// official addon guide uses it the same way) at `large` = 780x1170, which
// downscales to our 500x750 sharper and SMALLER than the `medium` variant.

const SUBS_API_URL = (process.env.SUBS_API_URL || 'http://titulky:8080').replace(/\/$/, '');
const INDEXER_URL = (process.env.INDEXER_URL || 'http://indexer:3003').replace(/\/$/, '');
const METAHUB_URL = 'https://images.metahub.space';

const DATA_DIR = path.join(__dirname, '..', 'data');
const INDEX_FILE = path.join(DATA_DIR, 'subs-index.json');
// public/ is part of the image and gets wiped on every deploy, data/ is a
// persistent volume — a full build takes ~15 min, so the posters live there and
// are served through a dedicated static route (see server.js).
const POSTERS_DIR = path.join(__dirname, '..', 'data', 'subs-posters');
const POSTER_W = 500, POSTER_H = 750;

// Be a polite guest on MetaHub/Cinemeta during a full 1150-item build.
const FETCH_DELAY_MS = parseInt(process.env.SUBS_INDEX_DELAY) || 600;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

for (const d of [DATA_DIR, POSTERS_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

let index = [];          // [{ imdb, anilist, mal, title, titleEn, langs, poster }]
let building = false;
let lastBuild = null;
let lastStats = null;

// ===== persistence =====
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    index = raw.items || [];
    lastBuild = raw.builtAt || null;
    lastStats = raw.stats || null;
    console.log(`📚 subs-index: loaded ${index.length} entries (built ${lastBuild || '?'})`);
  } catch { index = []; }
}
function save() {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ builtAt: lastBuild, stats: lastStats, items: index }, null, 0));
  } catch (e) { console.log(`📚 subs-index save: ${e.message}`); }
}
load();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Neither Cinemeta nor MetaHub publish rate limits, so treat 429/5xx as "slow
// down" rather than "give up": without this a momentary hiccup would leave a
// permanently empty field in the index.
async function getWithRetry(url, opts = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await axios.get(url, { timeout: 10000, ...opts });
    } catch (e) {
      const st = e.response?.status;
      if (attempt >= tries || !RETRY_STATUSES.has(st)) throw e;
      const wait = (e.response?.headers?.['retry-after'] ? parseInt(e.response.headers['retry-after']) * 1000 : 0) || attempt * 2000;
      console.log(`📚 subs-index: ${st} on ${url.slice(0, 60)} → retry in ${wait}ms`);
      await sleep(wait);
    }
  }
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ===== poster with the CZ/SK tag (style B1: square green tag, top left) =====
function tagSvg(text) {
  const fontSize = 30, padX = 16, h = 44;
  const w = Math.round(text.length * fontSize * 0.62 + padX * 2);
  return Buffer.from(`<svg width="${POSTER_W}" height="${POSTER_H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="16" y="16" width="${w}" height="${h}" rx="4" ry="4" fill="#0f7b3f"/>
    <text x="${16 + w / 2}" y="${16 + h / 2 + fontSize / 3}" font-family="Poppins, DejaVu Sans, sans-serif"
          font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle">${text}</text>
  </svg>`);
}

async function buildPoster(imdb, label) {
  const out = path.join(POSTERS_DIR, `si_${imdb}.jpg`);
  if (fs.existsSync(out)) return `/subs-posters/si_${imdb}.jpg`;   // already done
  // large (780x1170) downscales better than medium and ends up smaller
  const url = `${METAHUB_URL}/poster/large/${imdb}/img`;
  const resp = await getWithRetry(url, { responseType: 'arraybuffer', timeout: 15000 });

  // JPEG, no rounded corners: the spec asks for posters under 100 kB (50 kB
  // recommended) and a photographic poster as PNG lands around 190 kB. Stremio
  // rounds the tiles in its own UI anyway, so the corners are not missed.
  await sharp(Buffer.from(resp.data))
    .resize(POSTER_W, POSTER_H, { fit: 'cover' })
    .composite([{ input: tagSvg(label), top: 0, left: 0 }])
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(out);
  return `/subs-posters/si_${imdb}.jpg`;
}

// ===== build =====
async function buildIndex({ limit = 0, rebuild = false } = {}) {
  if (building) return { error: 'already running' };
  building = true;
  const t0 = Date.now();
  const stats = { total: 0, processed: 0, added: 0, skippedNoImdb: 0, posterFail: 0, alreadyHad: 0, retried: 0 };
  // Every title that did not make it in fully, with the reason — visible in
  // /api/subs-index/status, so a failed run can be inspected instead of just
  // leaving a count behind.
  const failures = [];

  try {
    const all = (await axios.get(`${SUBS_API_URL}/api/all`, { timeout: 30000 })).data;
    const anime = all.anime || all.items || (Array.isArray(all) ? all : []);
    stats.total = anime.length;

    const known = new Map(index.map(e => [e.imdb, e]));
    const todo = limit > 0 ? anime.slice(0, limit) : anime;

    for (const a of todo) {
      stats.processed++;
      try {
        // languages present for this anime
        const langs = new Set();
        for (const ep of a.episodes || []) {
          for (const s of ep.subs || []) if (s.lang) langs.add(String(s.lang).toUpperCase());
        }
        const label = ['CZ', 'SK'].filter(l => langs.has(l)).join('/') || [...langs].join('/');
        if (!label) continue;

        // anilist/mal → imdb
        const params = a.anilist_id ? `anilist=${a.anilist_id}` : (a.mal_id ? `mal=${a.mal_id}` : null);
        if (!params) { stats.skippedNoImdb++; failures.push({ title: a.anime_title, reason: 'no anilist/mal id' }); continue; }
        // One call gives us the imdb id AND every known title: resolve-ids
        // returns title / title_en / titles[] straight from the offline anime
        // database, so Cinemeta is no longer needed for the English name and
        // the alias list covers short forms ("KonoSuba" for "Kono Subarashii
        // Sekai ni Shukufuku wo!").
        let ids = null;
        try {
          ids = (await getWithRetry(`${INDEXER_URL}/api/resolve-ids?${params}`, { timeout: 8000 })).data || null;
        } catch {}
        const imdb = ids?.imdb_id || null;
        if (!imdb) { stats.skippedNoImdb++; failures.push({ title: a.anime_title, anilist: a.anilist_id, mal: a.mal_id, reason: 'no imdb mapping' }); continue; }

        // Only skip entries that are actually COMPLETE. A previous run that failed
        // to fetch the poster or the English title must be retried, otherwise a
        // one-off hiccup would stay broken forever (the only way back would be a
        // full rebuild, redrawing the ~1100 healthy ones for nothing).
        const prev = known.get(imdb);
        const complete = prev && prev.poster && Array.isArray(prev.aliases);
        if (!rebuild && complete) { stats.alreadyHad++; continue; }
        if (prev) stats.retried++;

        const titleEn = ids?.title_en || null;
        const aliases = Array.isArray(ids?.titles) ? ids.titles : [];
        // Stremio only knows movie / series. MOVIE from the offline database is
        // the only one that maps to "movie"; OVA, ONA and SPECIAL behave like a
        // one-episode series there, which is how Stremio itself treats them.
        const type = String(ids?.type || '').toUpperCase() === 'MOVIE' ? 'movie' : 'series';
        if (!titleEn && !aliases.length) failures.push({ title: a.anime_title, imdb, reason: 'no titles from resolve-ids' });

        let poster = null;
        try { poster = await buildPoster(imdb, label); }
        catch (e) { stats.posterFail++; failures.push({ title: a.anime_title, imdb, reason: 'poster: ' + (e.response?.status || e.message) }); }

        const romaji = ids?.title || a.anime_title || titleEn || imdb;
        const entry = {
          imdb, type,
          anilist: a.anilist_id || null,
          mal: a.mal_id || null,
          title: romaji,
          titleEn: titleEn || null,
          // Every alias the offline DB knows, capped so the index file stays
          // reasonable — the long tail is transliterations of the same name.
          aliases: aliases.slice(0, 40),
          langs: label,
          poster,
        };

        // Whole franchises share one imdb (every KonoSuba season is tt5370118),
        // so several source entries collapse into one index entry. Merging, not
        // overwriting, matters twice over: the label must not end up as
        // "Konosuba 3" just because that season happened to be processed last,
        // and the languages must be the UNION — otherwise a franchise with CZ in
        // season 1 and CZ/SK in season 3 would advertise only whichever came
        // last. The shortest romaji wins as the label, since a season marker
        // only ever makes the name longer.
        const existing = known.get(imdb);
        if (existing) {
          const langSet = new Set([
            ...String(existing.langs || '').split('/'),
            ...String(label || '').split('/'),
          ].map(x => x.trim()).filter(Boolean));
          entry.langs = ['CZ', 'SK'].filter(l => langSet.has(l))
            .concat([...langSet].filter(l => !['CZ', 'SK'].includes(l)))
            .join('/');

          // Prefer the label WITHOUT a season marker. Length alone is not a
          // guide: the database stores season 3 of KonoSuba as the short
          // "Konosuba 3", which would beat the full "Kono Subarashii Sekai ni
          // Shukufuku wo!" on length while being exactly the label we do not
          // want for a franchise entry.
          const mergedAliases = new Set([...(existing.aliases || []), ...entry.aliases]);
          const keepExisting = existing.title
            ? pickFranchiseTitle(existing.title, romaji) === existing.title
            : false;
          if (keepExisting) {
            mergedAliases.add(romaji);
            entry.title = existing.title;
          } else if (existing.title) {
            mergedAliases.add(existing.title);
          }
          if (existing.titleEn) mergedAliases.add(existing.titleEn);
          entry.aliases = [...mergedAliases].slice(0, 60);
          entry.poster = entry.poster || existing.poster;
          entry.titleEn = entry.titleEn || existing.titleEn;
        }
        known.set(imdb, entry);
        stats.added++;
        await sleep(FETCH_DELAY_MS);
      } catch (e) {
        failures.push({ title: a.anime_title, reason: e.message });
        console.log(`📚 subs-index: ${a.anime_title} → ${e.message}`);
      }
    }

    index = [...known.values()];
    lastBuild = new Date().toISOString();
    lastStats = { ...stats, seconds: Math.round((Date.now() - t0) / 1000), failures: failures.slice(0, 200), failureCount: failures.length };
    save();
    console.log(`📚 subs-index: ${stats.added} added, ${stats.retried} retried, ${stats.alreadyHad} complete, ${stats.skippedNoImdb} without imdb, ${stats.posterFail} poster fails, ${failures.length} issues (${lastStats.seconds}s) → ${index.length} total`);
    return lastStats;
  } catch (e) {
    console.log(`📚 subs-index build failed: ${e.message}`);
    return { error: e.message };
  } finally {
    building = false;
  }
}

// ===== search =====
function search(query) {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ').filter(Boolean);
  const squashedQuery = q.replace(/ /g, '');

  const exact = index.filter(e => {
    const hay = hayOf(e);
    if (words.every(w => hay.text.includes(w))) return true;
    // Space-insensitive: catches short forms that are simply the name run
    // together ("konosuba" → "kono subarashii…").
    return hay.flat.includes(squashedQuery);
  });
  if (exact.length) return exact.slice(0, 50);

  // Nothing matched exactly → try again tolerating typos. Deliberately loose:
  // a few extra results cost nothing (the user picks from the list anyway),
  // while a mistyped letter returning an empty section is what other addons
  // handle and we did not. Matching is done WORD BY WORD rather than by
  // sliding a window over the whole title: it is both closer to how people
  // mistype and an order of magnitude cheaper over ~900 entries.
  const budgetFor = (w) => (w.length <= 4 ? 1 : (w.length <= 8 ? 2 : 3));
  return index
    .filter(e => {
      const hay = hayOf(e);
      const fuzzyWord = (qw) => {
        const budget = budgetFor(qw);
        if (hay.words.some(nw => editDistanceWithin(qw, nw, budget))) return true;
        // also allow a typo inside a run-together form ("konosba")
        return editDistanceWithin(qw, hay.flat.slice(0, qw.length + budget), budget);
      };
      return words.every(fuzzyWord);
    })
    .slice(0, 50);
}

// Normalised text per entry, computed once and cached on the object: search
// runs over ~900 entries with dozens of aliases each, so re-normalising on
// every keystroke was the whole cost.
function hayOf(e) {
  if (!e._hay) {
    const text = [e.title, e.titleEn, ...(e.aliases || [])].map(norm).filter(Boolean).join(" ");
    e._hay = { text, flat: text.replace(/ /g, ""), words: [...new Set(text.split(" ").filter(Boolean))] };
  }
  return e._hay;
}

// Levenshtein distance that gives up as soon as the budget is exceeded.
function editDistanceWithin(a, b, budget) {
  if (!b) return false;
  if (Math.abs(a.length - b.length) > budget) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > budget) return false;
    prev = cur;
  }
  return prev[b.length] <= budget;
}

// Which of two titles better represents the whole franchise? Season markers
// ("2nd Season", "Movie", "Part 2", a trailing number or roman numeral) belong
// to one entry only, so a title without them wins; otherwise the shorter one.
function pickFranchiseTitle(a, b) {
  const seasonish = (t) => /(\b(season|movie|part|final|cour|ova|special|kan)\b|\s\d+$|\s(ii|iii|iv|v|vi)$)/i.test(String(t));
  const sa = seasonish(a), sb = seasonish(b);
  if (sa !== sb) return sa ? b : a;
  return a.length <= b.length ? a : b;
}

// Catalogue labels use the ROMAJI title (entry.title, straight from the offline
// anime database) — that is the name the user recognises. title_en is only a
// fallback, because the database often stores a fan abbreviation there ("CSM"
// for Chainsaw Man, "BL1" for Black Lagoon, "000" for 100-man no Inochi); those
// stay in aliases, where they are useful for SEARCHING but not as a label.
function displayName(entry) {
  const sane = (t) => t && t.length >= 4 && !/^[0\s]+$/.test(t);
  if (sane(entry.title)) return entry.title;
  if (sane(entry.titleEn)) return entry.titleEn;
  const alias = (entry.aliases || []).find(t => sane(t) && /[a-z]/i.test(t));
  return alias || entry.title || entry.titleEn || entry.imdb;
}

function buildMeta(entry, baseUrl) {
  return {
    id: entry.imdb,
    type: entry.type || 'series',
    name: displayName(entry),
    poster: entry.poster ? `${baseUrl}${entry.poster}` : `${METAHUB_URL}/poster/medium/${entry.imdb}/img`,
    description: `CZ/SK titulky k dispozici (${entry.langs})`,
  };
}

function status() {
  return {
    entries: index.length,
    incomplete: index.filter(e => !e.poster || !e.titleEn).length,
    building,
    lastBuild,
    lastStats,
  };
}

module.exports = { buildIndex, search, buildMeta, status };
