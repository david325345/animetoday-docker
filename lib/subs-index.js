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
        const type = 'series';
        if (!titleEn && !aliases.length) failures.push({ title: a.anime_title, imdb, reason: 'no titles from resolve-ids' });

        let poster = null;
        try { poster = await buildPoster(imdb, label); }
        catch (e) { stats.posterFail++; failures.push({ title: a.anime_title, imdb, reason: 'poster: ' + (e.response?.status || e.message) }); }

        const entry = {
          imdb, type,
          anilist: a.anilist_id || null,
          mal: a.mal_id || null,
          title: ids?.title || a.anime_title || titleEn || imdb,
          titleEn: titleEn || null,
          // Every alias the offline DB knows, capped so the index file stays
          // reasonable — the long tail is transliterations of the same name.
          aliases: aliases.slice(0, 40),
          langs: label,
          poster,
        };
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

  return index
    .filter(e => {
      const hay = [e.title, e.titleEn, ...(e.aliases || [])].map(norm).join(' ');
      if (words.every(w => hay.includes(w))) return true;
      // Space-insensitive fallback: catches short forms that are simply the
      // name run together ("konosuba" → "kono subarashii…") even when the
      // alias list does not carry them.
      return hay.replace(/ /g, '').includes(squashedQuery);
    })
    .slice(0, 50);
}

function buildMeta(entry, baseUrl) {
  return {
    id: entry.imdb,
    type: entry.type || 'series',
    name: entry.titleEn || entry.title,
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
