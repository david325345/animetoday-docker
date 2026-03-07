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
    if (/\bcomplete\b|\bbatch\b/i.test(name)) return true;
    const m = name.match(/(\d+)\s*[-~]\s*(\d+)/);
    return m && parseInt(m[2]) > parseInt(m[1]) && ep >= parseInt(m[1]) && ep <= parseInt(m[2]);
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

  const searchNameNorm = animeName.toLowerCase().replace(/[;:]/g, '').replace(/\s+/g, ' ').trim();
  const batchWords = new Set(['complete', 'batch', 'collection', 'series', 'bd', 'bluray', 'blu-ray']);
  const particleWords = new Set(['the', 'no', 'wo', 'wa', 'ga', 'ni', 'to', 'de', 'tv', 'ova']);

  filtered = filtered.filter(t => {
    const torrentNorm = (t.name || '').toLowerCase().replace(/[;:]/g, '').replace(/[\[\]()_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const idx = torrentNorm.indexOf(searchNameNorm);
    if (idx === -1) return true;
    const afterName = torrentNorm.slice(idx + searchNameNorm.length).trim();
    const nextWord = afterName.split(/\s+/)[0] || '';
    if (!nextWord) return true;
    if (/^\d{2,}/.test(nextWord)) return true;
    if (/^s\d+e\d+/i.test(nextWord)) return true;
    if (batchWords.has(nextWord) || particleWords.has(nextWord)) return true;
    if (/^\d$/.test(nextWord)) return false;
    if (/^[a-z]{2,}$/i.test(nextWord)) return false;
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

  // Search ALL variants in parallel
  const seenHashes = new Set();
  const allTorrents = [];

  const results = await Promise.allSettled(
    variantList.map(q => si.searchAll(q, { filter: 0, category: '1_2' }).catch(() => []))
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of (r.value || [])) {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) { seenHashes.add(hash); allTorrents.push(t); }
    }
  }

  console.log(`  [Nyaa.si] ${allTorrents.length} raw results from ${variantList.length} queries`);

  // Filter
  const primaryName = names[0] || '';
  let filtered = filterJunk(allTorrents, primaryName);
  filtered = filterByEpisode(filtered, episode);
  filtered = filterBySeason(filtered, season);

  // Sukebei fallback
  if (filtered.length === 0 && names.length > 0) {
    console.log('  ⚠️ Trying Sukebei...');
    const sukebei = await searchSukebei(names, episode);
    filtered.push(...sukebei);
  }

  const sorted = filtered.sort((a, b) => (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0));
  if (sorted.length) console.log(`  ✅ Total: ${sorted.length} torrents`);
  else console.log('  ❌ No torrents found');

  nyaaCache.set(cacheKey, { data: sorted, timestamp: Date.now() });
  return sorted;
}

// ===== Sukebei fallback =====
async function searchSukebei(names, episode) {
  const epPad = episode ? String(episode).padStart(2, '0') : '';
  const allTorrents = [];
  const seenHashes = new Set();

  for (const name of names.slice(0, 2)) {
    const query = episode ? `${name} ${epPad}` : name;
    try {
      const resp = await axios.get('https://sukebei.nyaa.si/', {
        params: { f: 0, c: '0_0', q: query, s: 'seeders', o: 'desc' },
        timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnimeAddon/5.0)' }
      });
      const html = resp.data;
      const magnets = html.match(/magnet:\?xt=urn:btih:[a-fA-F0-9]+[^"']*/g) || [];
      const rowRegex = /<tr[^>]*class="(?:default|success|danger)"[^>]*>([\s\S]*?)<\/tr>/g;
      let match, i = 0;
      while ((match = rowRegex.exec(html)) !== null && i < magnets.length) {
        const row = match[1];
        const nameMatch = row.match(/<a[^>]*href="\/view\/\d+"[^>]*>([^<]+)<\/a>/);
        const sizeMatch = row.match(/<td[^>]*class="text-center"[^>]*>(\d+[\d.]*\s*[KMGT]iB)<\/td>/);
        const seederMatch = row.match(/<td[^>]*class="text-center"[^>]*style="color:\s*green[^"]*"[^>]*>(\d+)<\/td>/);
        const hash = magnets[i].match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
        if (hash && !seenHashes.has(hash)) {
          seenHashes.add(hash);
          allTorrents.push({
            name: nameMatch?.[1]?.trim() || 'Unknown',
            magnet: magnets[i], seeders: seederMatch?.[1] || '0',
            filesize: sizeMatch?.[1] || 'Unknown', source: 'sukebei'
          });
        }
        i++;
      }
      if (allTorrents.length) { console.log(`  [Sukebei] "${query}" → ${allTorrents.length}`); break; }
    } catch {}
  }
  return allTorrents;
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
