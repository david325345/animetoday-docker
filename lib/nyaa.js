const axios = require('axios');
const { normalizeMacrons } = require('./anilist');

const nyaaCache = new Map();
const NYAA_CACHE_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nyaaCache) if (now - v.timestamp > NYAA_CACHE_TTL) nyaaCache.delete(k);
}, 30 * 60 * 1000);

// ===== Search variant builders =====
function cleanAnimeName(name) {
  return name
    .replace(/Season\s*\d+/i, '').replace(/Part\s*\d+/i, '')
    .replace(/\d+(st|nd|rd|th)\s*Season/i, '')
    .replace(/2nd Season|3rd Season/i, '')
    .replace(/\([^)]*\)/g, '').replace(/:/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function buildSearchVariants(animeName, episode, season = 1) {
  const clean = cleanAnimeName(animeName);
  const normalized = normalizeMacrons(animeName);

  // Keep only the most useful base names (max 3)
  const base = [...new Set([animeName, clean, ...normalized].filter(Boolean))].slice(0, 3);

  if (episode != null) {
    const epPad = String(episode).padStart(2, '0');
    const seasonPad = String(season).padStart(2, '0');
    // Only 2 formats: "Name 01" and "Name S01E01"
    return base.flatMap(n => [
      `${n} ${epPad}`,
      `${n} S${seasonPad}E${epPad}`,
    ]);
  }
  return base;
}

// ===== Episode filtering =====
function filterByEpisode(torrents, episode) {
  if (episode == null) return torrents;
  const ep = parseInt(episode);
  const epPad = String(ep).padStart(2, '0');

  function isBatch(name) {
    const n = name.toLowerCase();
    // Explicit batch/complete keywords
    if (/\bcomplete\b|\bbatch\b|\bcollection\b/i.test(name)) return true;
    // Season pack: "Season 1", "(Season 1)", "S01" without episode
    if (/\bSeason\s*\d+\b/i.test(name) && !/\bE\d{2}\b/i.test(name)) return true;
    if (/\bS\d{2}\b/i.test(name) && !/\bS\d{2}E\d{2}\b/i.test(name)) return true;
    // Range like "01-12", "01~28", "01 - 28", "Vol. 01-27"
    const rangeMatch = name.match(/(\d+)\s*[-~]\s*(\d+)/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]);
      const to = parseInt(rangeMatch[2]);
      if (to > from && to - from >= 2 && ep >= from && ep <= to) return true;
    }
    // BD/Blu-ray packs without episode number (likely full series)
    if (/\b(?:BD|BDRip|Blu-?ray)\b/i.test(name) && !/\bE\d{2}\b/i.test(name) && !/\s-\s\d{1,3}[\s.\[]/i.test(name)) {
      // Check it doesn't have a specific episode marker
      const stripped = name.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '');
      if (!/\b\d{1,2}\b/.test(stripped.replace(/\d{3,}/g, ''))) return true; // no small numbers = batch
    }
    return false;
  }

  function matchesEp(name) {
    const norm = name.replace(/[\[\]\(\)_.\-]/g, ' ').replace(/\s+/g, ' ');
    const n = norm.toLowerCase();
    const raw = name;

    // === Existing patterns ===
    if (n.includes(' ' + epPad + ' ') || n.includes(' ' + epPad + 'v')
      || n.includes('e' + epPad + ' ') || n.includes('ep' + epPad + ' ')
      || n.trimEnd().endsWith(' ' + epPad) || n.trimEnd().endsWith('e' + epPad)) return true;

    // === Sonarr-style patterns (from Parser.cs) ===

    // S01E02 / S1E2 — standard season+episode
    if (new RegExp(`S\\d{1,2}E0*${ep}(?:\\b|[^\\d])`, 'i').test(raw)) return true;

    // Absolute episode: [Group] Title - 02 [quality]
    // Sonarr: ^(?:\[.+?\][-_. ]?)?(?:.+?)[-_. ]+(?<absoluteepisode>\d{2,3})
    if (new RegExp(`[-_ ]0*${ep}(?:\\s|\\[|\\(|v\\d|$)`, 'i').test(raw)) return true;

    // Episode in square brackets: [02] or [02v2]
    if (new RegExp(`\\[0*${ep}(?:v\\d)?\\]`, 'i').test(raw)) return true;

    // "Episode 02" / "Episode 2" / "Ep 02" / "Ep.02"
    if (new RegExp(`\\bEp(?:isode)?[-_. ]*0*${ep}(?:\\b|[^\\d])`, 'i').test(raw)) return true;

    // " - 02" pattern (common anime fansub style)
    if (new RegExp(`\\s-\\s0*${ep}(?:\\s|\\[|\\(|v\\d|\\.|$)`, 'i').test(raw)) return true;

    // "#02" pattern
    if (new RegExp(`#0*${ep}(?:\\b|[^\\d])`, 'i').test(raw)) return true;

    // 3-digit absolute: 002 (for long-running series)
    const ep3 = String(ep).padStart(3, '0');
    if (new RegExp(`[-_ ]${ep3}(?:\\s|\\[|\\(|v\\d|\\.|$)`, 'i').test(raw)) return true;

    // Multi-episode: E01-E02 or E01E02 — match if our ep is in range
    const multiMatch = raw.match(/E(\d{2,3})[-_]?E(\d{2,3})/i);
    if (multiMatch) {
      const from = parseInt(multiMatch[1]);
      const to = parseInt(multiMatch[2]);
      if (ep >= from && ep <= to) return true;
    }

    // Dot-separated: Title.S01E02.1080p or Title.02.1080p
    if (new RegExp(`\\.0*${ep}\\.`, 'i').test(raw)) return true;

    return false;
  }

  return torrents.filter(t => matchesEp(t.name || '') || isBatch(t.name || ''));
}

// ===== Season filtering =====
function filterBySeason(torrents, season) {
  if (season == null) return torrents;

  const s2plusKeywords = [
    'entertainment district', 'mugen train', 'swordsmith', 'hashira training', 'infinity castle',
    'phantom blood', 'battle tendency', 'stardust crusaders', 'diamond is unbreakable',
    'golden wind', 'stone ocean', 'election arc', 'chimera ant', 'succession war',
    'marineford', 'dressrosa', 'whole cake', 'wano',
  ];

  return torrents.filter(t => {
    const name = t.name || '';
    const nameLower = name.toLowerCase();
    const sMatch = name.match(/\bS(\d+)(?:E|\b)/i);
    if (sMatch && parseInt(sMatch[1]) !== season) return false;
    const seasonMatch = name.match(/\bSeason\s*(\d+)/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== season) return false;
    if (season !== 2 && /\b2nd\s*Season\b/i.test(name)) return false;
    if (season !== 3 && /\b3rd\s*Season\b/i.test(name)) return false;
    if (season !== 4 && /\b4th\s*Season\b/i.test(name)) return false;
    if (season === 1 && s2plusKeywords.some(kw => nameLower.includes(kw))) return false;
    return true;
  });
}

// ===== Junk/spinoff filtering =====
function filterJunk(torrents, animeName) {
  const junkPattern = /mini anime|mini-anime|recap|\bova\b|\bspecial\b|ncop|nced|\bpv\b|preview|trailer/i;
  let filtered = torrents.filter(t => {
    if (junkPattern.test(t.name || '')) {
      console.log(`  [Junk] REMOVED (pattern): ${(t.name || '').substring(0, 80)}`);
      return false;
    }
    return true;
  });

  // Normalize: remove punctuation, lowercase, collapse spaces
  const searchNameNorm = animeName.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/\s+/g, ' ').trim();
  const searchWords = searchNameNorm.split(/\s+/).filter(w => w.length > 1);
  const batchWords = new Set(['complete', 'batch', 'collection', 'series', 'bd', 'bluray', 'blu-ray']);
  const particleWords = new Set(['the', 'no', 'wo', 'wa', 'ga', 'ni', 'to', 'de', 'tv', 'ova']);
  const commonWords = new Set(['new', 'the', 'a', 'an', 'of', 'in', 'at', 'on', 'to', 'for', 'vs', 'and', 'or', 'my', 'is', 'are']);

  // Only do strict before-name check for single-word names like "Gate"
  const isVeryShortName = searchWords.length === 1;

  const beforeJunk = filtered.length;
  filtered = filtered.filter(t => {
    const rawName = (t.name || '');
    // Strip fansub tags in brackets, then normalize same way
    const stripped = rawName.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    const torrentNorm = stripped.toLowerCase().replace(/[;:.,!?'"]/g, ' ').replace(/[\[\]()_\-]/g, ' ').replace(/\s+/g, ' ').trim();

    const idx = torrentNorm.indexOf(searchNameNorm);
    if (idx === -1) return true;

    // For single-word names (like "Gate"): check word before isn't part of another title
    if (isVeryShortName && idx > 0) {
      const beforeStr = torrentNorm.slice(0, idx).trim();
      const wordBefore = beforeStr.split(/\s+/).pop() || '';
      if (wordBefore.length >= 2 && /^[a-z]+$/.test(wordBefore) &&
          !particleWords.has(wordBefore) && !batchWords.has(wordBefore) &&
          !commonWords.has(wordBefore)) {
        console.log(`  [Junk] REMOVED (word before "${wordBefore}"): ${rawName.substring(0, 80)}`);
        return false;
      }
    }

    // Standard after-name check
    const afterName = torrentNorm.slice(idx + searchNameNorm.length).trim();
    const nextWord = afterName.split(/\s+/)[0] || '';
    if (!nextWord) return true;
    if (/^\d{2,}/.test(nextWord)) return true;
    if (/^s\d+e\d+/i.test(nextWord)) return true;
    if (batchWords.has(nextWord) || particleWords.has(nextWord)) return true;
    if (/^\d$/.test(nextWord)) { console.log(`  [Junk] REMOVED (single digit "${nextWord}"): ${rawName.substring(0, 80)}`); return false; }
    // Only reject next-word for long names (3+ words)
    if (/^[a-z]{2,}$/i.test(nextWord) && searchWords.length >= 3) { console.log(`  [Junk] REMOVED (word after "${nextWord}"): ${rawName.substring(0, 80)}`); return false; }
    return true;
  });
  if (beforeJunk !== filtered.length) console.log(`  [Junk] Spinoff filter: ${beforeJunk} → ${filtered.length}`);

  return filtered;
}

// ===== Nyaa.si search =====
// Collect all variants from all names, search ALL in parallel
async function searchNyaa(names, episode, season = 1) {
  const cacheKey = `nyaa:${names.join('|')}:${episode}:s${season}`;
  const cached = nyaaCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < NYAA_CACHE_TTL) {
    console.log(`  🔍 Nyaa: ✅ Cache hit`);
    return cached.data;
  }

  // Build variants from all names — episode-specific only for Nyaa
  const allVariants = new Set();
  for (const name of names) {
    if (!name) continue;
    for (const v of buildSearchVariants(name, episode, season)) allVariants.add(v);
  }

  // Limit Nyaa queries to 10 max (AnimeTosho handles batch/name-only searches)
  const variantList = [...allVariants].slice(0, 10);
  console.log(`  🔍 Search: ${variantList.length} Nyaa queries for [${names.join(', ')}] ep${episode || '?'} s${season}`);

  const seenHashes = new Set();
  const allTorrents = [];

  // Search Nyaa.si (direct RSS) AND AnimeTosho in parallel
  const [nyaaResults, toshoResults] = await Promise.all([
    searchNyaaDirect(variantList),
    searchAnimeTosho(names, episode)
  ]);

  // Collect Nyaa results
  for (const t of nyaaResults) {
    const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
    if (hash && !seenHashes.has(hash)) { seenHashes.add(hash); t.source = 'nyaa'; allTorrents.push(t); }
  }

  // Collect AnimeTosho results
  for (const t of toshoResults) {
    const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
    if (hash && !seenHashes.has(hash)) { seenHashes.add(hash); allTorrents.push(t); }
  }

  console.log(`  [Nyaa.si+AnimeTosho] ${allTorrents.length} raw results`);

  // Filter
  const primaryName = names[0] || '';
  let filtered = filterJunk(allTorrents, primaryName);
  console.log(`  [Filter] afterJunk: ${filtered.length}`);
  filtered = filterByEpisode(filtered, episode);
  console.log(`  [Filter] afterEpisode: ${filtered.length}`);
  filtered = filterBySeason(filtered, season);
  console.log(`  [Filter] afterSeason: ${filtered.length}`);

  // Movie filter: if no episode/season, remove torrents that look like series episodes
  if (episode == null && season == null) {
    filtered = filterMovieResults(filtered, names);
  }

  const sorted = filtered.sort((a, b) => (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0));
  if (sorted.length) console.log(`  ✅ Total: ${sorted.length} torrents`);
  else console.log('  ❌ No torrents found');

  nyaaCache.set(cacheKey, { data: sorted, timestamp: Date.now() });
  return sorted;
}

// ===== Movie filter: remove series episodes =====
function filterMovieResults(torrents, names) {
  const movieNames = names.map(n => n.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/\s+/g, ' ').trim());
  const longestName = movieNames.reduce((a, b) => a.length >= b.length ? a : b, '');
  const longestWords = longestName.split(/\s+/).filter(w => w.length > 1);
  // Shortest name for basic relevance check (e.g. "Goblin Slayer")
  const shortestName = movieNames.reduce((a, b) => a.length <= b.length ? a : b, movieNames[0]);

  return torrents.filter(t => {
    const name = (t.name || '');
    const nameLower = name.toLowerCase();
    const nameNorm = nameLower.replace(/[;:.,!?'"]/g, '').replace(/[\[\]()_\-]/g, ' ').replace(/\s+/g, ' ').trim();

    // 1. Must contain at least the shortest movie name (basic relevance)
    if (!nameNorm.includes(shortestName)) return false;

    // 2. Reject explicit series patterns
    if (/\bS\d+E\d+\b/i.test(name)) return false;
    if (/\bEpisode\s+\d+/i.test(name)) return false;
    // " - 01 " style episode markers
    if (/\s-\s\d{1,3}(?:\s|[.\[v]|$)/.test(name)) return false;

    // 3. Reject season indicators (Season 1, S01, S02, etc.)
    if (/\bS\d{2}\b/i.test(name) && !/movie|film|gekijouban|crown/i.test(name)) return false;
    if (/\bSeason\s*\d+/i.test(name)) return false;
    if (/\b\d+(st|nd|rd|th)\s*Season\b/i.test(name)) return false;

    // 4. Reject EP/E patterns (unless "EP" is in movie title)
    if (/\bEP?\s*\d{1,3}\b/i.test(name) && !/\bEP\b/i.test(longestName)) return false;

    // 5. Reject standalone small numbers (episode-like)
    const stripped = name.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim();
    const numMatch = stripped.match(/\s(\d{1,3})(?:\s|$)/);
    if (numMatch) {
      const num = parseInt(numMatch[1]);
      if (num > 0 && num < 100) return false; // episode number, not year
    }

    // 6. For long movie titles (3+ words), require good word match
    if (longestWords.length >= 3) {
      const matchCount = longestWords.filter(w => nameNorm.includes(w)).length;
      const matchRatio = matchCount / longestWords.length;
      if (matchRatio < 0.5) return false;
    }

    return true;
  });
}

// ===== Direct Nyaa.si search (HTML scraping, replaces nyaapi) =====
async function searchNyaaDirect(queries) {
  const seenHashes = new Set();
  const allTorrents = [];

  // Deduplicate and limit queries
  const uniqueQueries = [...new Set(queries)].slice(0, 10);

  const results = await Promise.allSettled(
    uniqueQueries.map(q =>
      axios.get('https://nyaa.si/', {
        params: { f: 0, c: '1_2', q, s: 'seeders', o: 'desc' },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnimeAddon/5.0)' }
      }).then(resp => {
        const html = resp.data || '';
        const torrents = [];
        // Parse rows
        const rowRegex = /<tr[^>]*class="(?:default|success|danger)"[^>]*>([\s\S]*?)<\/tr>/g;
        const magnetRegex = /magnet:\?xt=urn:btih:[a-fA-F0-9]+[^"']*/g;
        const allMagnets = html.match(magnetRegex) || [];
        let match, idx = 0;
        while ((match = rowRegex.exec(html)) !== null && idx < allMagnets.length) {
          const row = match[1];
          // Extract name from the second <a> in the title column (links to /view/...)
          const nameMatch = row.match(/<td[^>]*colspan="2"[^>]*>[\s\S]*?<a[^>]*href="\/view\/\d+"[^>]*>([^<]+)<\/a>/);
          const sizeMatch = row.match(/<td[^>]*class="text-center"[^>]*>(\d+[\d.]*\s*[KMGT]iB)<\/td>/);
          const seederMatch = row.match(/<td[^>]*class="text-center"[^>]*style="color:\s*green[^"]*"[^>]*>(\d+)<\/td>/);
          torrents.push({
            name: (nameMatch?.[1] || '').trim(),
            magnet: allMagnets[idx],
            seeders: seederMatch?.[1] || '0',
            filesize: sizeMatch?.[1] || 'Unknown',
            source: 'nyaa'
          });
          idx++;
        }
        return torrents;
      }).catch(() => [])
    )
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of (r.value || [])) {
      if (!t.magnet || !t.name) continue;
      const hash = t.magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) { seenHashes.add(hash); allTorrents.push(t); }
    }
  }

  if (allTorrents.length) console.log(`  [Nyaa.si] ${allTorrents.length} results from ${uniqueQueries.length} queries`);
  return allTorrents;
}

// ===== AnimeTosho JSON API =====
async function searchAnimeTosho(names, episode) {
  const seenHashes = new Set();
  const allTorrents = [];
  const epPad = episode ? String(episode).padStart(2, '0') : '';
  const seasonEp = episode ? `S01E${epPad}` : '';

  // Build multiple queries from all names
  const queries = new Set();
  for (const name of names) {
    if (!name) continue;
    if (episode) {
      queries.add(`${name} ${epPad}`);
      queries.add(`${name} ${seasonEp}`);
    }
    queries.add(name); // name-only for batches
  }

  const queryList = [...queries].slice(0, 6);
  console.log(`  [AnimeTosho] ${queryList.length} queries`);

  // Search all queries in parallel
  const results = await Promise.allSettled(
    queryList.map(q =>
      axios.get('https://feed.animetosho.org/json', {
        params: { q, qx: 1, limit: 100 }, timeout: 10000
      }).then(r => r.data || []).catch(() => [])
    )
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of (r.value || [])) {
      const magnet = item.magnet_uri;
      if (!magnet) continue;
      const hash = magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        allTorrents.push({
          name: item.title || 'Unknown',
          magnet,
          seeders: String(item.seeders || 0),
          filesize: item.total_size ? formatBytes(item.total_size) : 'Unknown',
          source: 'animetosho'
        });
      }
    }
  }

  if (allTorrents.length) console.log(`  [AnimeTosho] ${allTorrents.length} results`);
  return allTorrents;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GiB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MiB';
  return (bytes / 1024).toFixed(1) + ' KiB';
}

// ===== Quality detection =====
function detectQuality(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return '4K';
  if (n.includes('1080p') || n.includes('fullhd')) return '1080p';
  if (n.includes('720p') || n.includes('hd')) return '720p';
  if (n.includes('480p') || n.includes('sd')) return '480p';
  return '';
}

// ===== Group priority (for Nyaa addon sorting) =====
const TOP_GROUPS = ['SubsPlease', 'Erai-raws'];
const OTHER_GROUPS = ['EMBER', 'ASW'];

function sortByGroupPriority(torrents) {
  function getGroupPriority(name) {
    const all = [...TOP_GROUPS, ...OTHER_GROUPS];
    for (let i = 0; i < all.length; i++) if ((name || '').includes(all[i])) return i;
    return all.length;
  }

  const withMagnet = torrents.filter(t => t.magnet && (parseInt(t.seeders) || 0) > 0 && !/480p/i.test(t.name || ''));
  const top = withMagnet.filter(t => TOP_GROUPS.some(g => (t.name || '').includes(g)) && /1080p/i.test(t.name || ''))
    .sort((a, b) => getGroupPriority(a.name) - getGroupPriority(b.name) || (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0));
  const topHashes = new Set(top.map(t => t.magnet));
  const rest = withMagnet.filter(t => !topHashes.has(t.magnet))
    .sort((a, b) => {
      const a1 = /1080p/i.test(a.name) ? 0 : 1, b1 = /1080p/i.test(b.name) ? 0 : 1;
      if (a1 !== b1) return a1 - b1;
      return getGroupPriority(a.name) - getGroupPriority(b.name) || (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0);
    });
  return [...top, ...rest];
}

module.exports = { searchNyaa, detectQuality, sortByGroupPriority, filterByEpisode };
