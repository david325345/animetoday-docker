const { si } = require('nyaapi');
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
  const normalizedClean = normalizeMacrons(clean);
  const afterColon = animeName.includes(':') ? animeName.split(':').slice(1).join(':').trim() : null;
  const firstPart = animeName.split(':')[0].trim();
  const noSpecial = animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const base = [...new Set([animeName, clean, firstPart !== animeName ? firstPart : null,
    noSpecial !== clean ? noSpecial : null, ...normalized, ...normalizedClean,
    afterColon].filter(Boolean))];

  if (episode != null) {
    const epPad = String(episode).padStart(2, '0');
    const seasonPad = String(season).padStart(2, '0');
    return base.flatMap(n => [
      `${n} ${epPad}`,
      `${n} S${seasonPad}E${epPad}`,
      `${n} ${episode}`,
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
    return n.includes(' ' + epPad + ' ') || n.includes(' ' + epPad + 'v')
      || n.includes('e' + epPad + ' ') || n.includes('ep' + epPad + ' ')
      || n.trimEnd().endsWith(' ' + epPad) || n.trimEnd().endsWith('e' + epPad)
      || new RegExp(`[-_\\s]\\s*${epPad}(?:[\\s\\-_v.]|$)`, 'i').test(name)
      || new RegExp(`[-_\\s]\\s*${ep}(?:[\\s\\-_v.]|$)`, 'i').test(name)
      || new RegExp(`s\\d+e${epPad}(?:[\\s\\-_v.]|$)`, 'i').test(name);
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
  let filtered = torrents.filter(t => !junkPattern.test(t.name || ''));

  // Normalize: remove punctuation, lowercase, collapse spaces
  const searchNameNorm = animeName.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/\s+/g, ' ').trim();
  const searchWords = searchNameNorm.split(/\s+/).filter(w => w.length > 1);
  const batchWords = new Set(['complete', 'batch', 'collection', 'series', 'bd', 'bluray', 'blu-ray']);
  const particleWords = new Set(['the', 'no', 'wo', 'wa', 'ga', 'ni', 'to', 'de', 'tv', 'ova']);
  const commonWords = new Set(['new', 'the', 'a', 'an', 'of', 'in', 'at', 'on', 'to', 'for', 'vs', 'and', 'or', 'my', 'is', 'are']);

  // Only do strict before-name check for single-word names like "Gate"
  const isVeryShortName = searchWords.length === 1;

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
    if (/^\d$/.test(nextWord)) return false;
    // Only reject next-word for long names (3+ words)
    if (/^[a-z]{2,}$/i.test(nextWord) && searchWords.length >= 3) return false;
    return true;
  });

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

  // Build all variants from all names at once
  const allVariants = new Set();
  for (const name of names) {
    if (!name) continue;
    for (const v of buildSearchVariants(name, episode, season)) allVariants.add(v);
    // Also add name-only (catches batch packs)
    for (const v of buildSearchVariants(name, null)) allVariants.add(v);
  }

  const variantList = [...allVariants];
  console.log(`  🔍 Nyaa: ${variantList.length} variants for [${names.join(', ')}] ep${episode || '?'} s${season}`);

  const seenHashes = new Set();
  const allTorrents = [];

  // Search Nyaa.si AND AnimeTosho in parallel
  const [nyaaResults, toshoResults] = await Promise.all([
    Promise.allSettled(
      variantList.map(q => si.searchAll(q, { filter: 0, category: '1_2' }).catch(() => []))
    ),
    searchAnimeTosho(names, episode)
  ]);

  // Collect Nyaa results
  for (const r of nyaaResults) {
    if (r.status !== 'fulfilled') continue;
    for (const t of (r.value || [])) {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) { seenHashes.add(hash); allTorrents.push(t); }
    }
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
  filtered = filterByEpisode(filtered, episode);
  filtered = filterBySeason(filtered, season);

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

// ===== AnimeTosho JSON API =====
async function searchAnimeTosho(names, episode) {
  const allTorrents = [];
  const seenHashes = new Set();
  const epPad = episode ? String(episode).padStart(2, '0') : '';

  for (const name of names.slice(0, 2)) {
    const query = episode ? `${name} ${epPad}` : name;
    try {
      const resp = await axios.get('https://feed.animetosho.org/json', {
        params: { q: query, qx: 1, limit: 50 },
        timeout: 10000
      });
      for (const item of (resp.data || [])) {
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
      if (allTorrents.length) {
        console.log(`  [AnimeTosho] "${query}" → ${allTorrents.length}`);
        break;
      }
    } catch (err) {
      console.error(`  [AnimeTosho] Error: ${err.message}`);
    }
  }
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
