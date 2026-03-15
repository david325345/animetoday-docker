const axios = require('axios');

// ===== Nyaa RSS Indexer =====
// Fetches RSS every 10 min, accumulates all torrents in RAM for the day
// Cleared on daily anime cache update

const RSS_URL = 'https://nyaa.si/?page=rss&c=1_2'; // Anime - English-translated only
const RSS_INTERVAL = 10 * 60 * 1000; // 10 minutes

let rssIndex = []; // [{ title, magnet, seeders, size, guid, timestamp }]
let lastGuid = null; // Last seen guid to avoid duplicates
let rssTimer = null;
let rssFetchCount = 0;

function getRssStats() {
  return { count: rssIndex.length, lastGuid, fetches: rssFetchCount };
}

// Clear RSS index (called on daily cache update)
function clearRssIndex() {
  const oldCount = rssIndex.length;
  rssIndex = [];
  lastGuid = null;
  rssFetchCount = 0;
  if (oldCount > 0) console.log(`📡 RSS: Cleared ${oldCount} entries`);
}

// Start RSS fetching loop
function startRssFetcher() {
  console.log('📡 RSS: Starting Nyaa RSS fetcher (every 10 min, anime EN only)');
  fetchRss(); // Initial fetch
  rssTimer = setInterval(fetchRss, RSS_INTERVAL);
}

function stopRssFetcher() {
  if (rssTimer) { clearInterval(rssTimer); rssTimer = null; }
}

async function fetchRss() {
  try {
    const resp = await axios.get(RSS_URL, { timeout: 15000, responseType: 'text' });
    const xml = resp.data || '';

    // Parse RSS items
    const items = parseRssXml(xml);
    if (!items.length) return;

    // Find new items (after lastGuid)
    let newItems = [];
    if (lastGuid) {
      const lastIdx = items.findIndex(i => i.guid === lastGuid);
      if (lastIdx > 0) {
        newItems = items.slice(0, lastIdx); // Items before lastGuid are newer
      } else if (lastIdx === -1) {
        newItems = items; // lastGuid not found, all are new
      }
      // lastIdx === 0 means no new items
    } else {
      newItems = items; // First fetch, take all
    }

    if (newItems.length > 0) {
      // Deduplicate by guid
      const existingGuids = new Set(rssIndex.map(i => i.guid));
      const unique = newItems.filter(i => !existingGuids.has(i.guid));

      rssIndex.push(...unique);
      lastGuid = items[0].guid; // Most recent item
      rssFetchCount++;

      if (unique.length > 0) {
        console.log(`📡 RSS: +${unique.length} new (${rssIndex.length} total, fetch #${rssFetchCount})`);
      }
    } else {
      rssFetchCount++;
    }
  } catch (err) {
    console.error(`📡 RSS fetch error: ${err.message}`);
  }
}

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1];

    const title = content.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
      || content.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link = content.match(/<link>(.*?)<\/link>/)?.[1] || '';
    const guid = content.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || '';
    const seeders = content.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/)?.[1] || '0';
    const size = content.match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1] || '';

    // Extract magnet from infoHash field
    let magnet = '';
    const magnetMatch = content.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/);
    if (magnetMatch) {
      magnet = `magnet:?xt=urn:btih:${magnetMatch[1]}`;
    }
    // Fallback: try link if it's a magnet
    if (!magnet && link.startsWith('magnet:')) {
      magnet = link;
    }

    if (title && (magnet || guid)) {
      items.push({
        title: title.trim(),
        magnet,
        seeders,
        size,
        guid,
        timestamp: Date.now()
      });
    }
  }

  return items;
}

// ===== Search RSS index by anime name + episode =====
function searchRssIndex(names, episode) {
  if (!rssIndex.length || !names.length) return [];

  const ep = parseInt(episode);
  const epPad = String(ep).padStart(2, '0');

  // Build name patterns for matching
  const namePatterns = names.map(n => {
    return n.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/\s+/g, ' ').trim();
  }).filter(n => n.length > 2);

  // Episode patterns
  const epPatterns = [
    new RegExp(`S\\d{1,2}E${epPad}\\b`, 'i'),           // S01E04, S02E04
    new RegExp(`\\s-\\s${epPad}(?:\\s|\\[|\\(|v\\d|\\.|$)`), // " - 04 "
    new RegExp(`\\[${epPad}(?:v\\d)?\\]`),                  // [04]
    new RegExp(`\\bEp(?:isode)?\\s*${epPad}\\b`, 'i'),      // Ep04, Episode 04
  ];

  const results = [];
  const seenHashes = new Set();

  for (const item of rssIndex) {
    const titleNorm = item.title.toLowerCase().replace(/[;:.,!?'"]/g, '').replace(/[\[\]()_\-]/g, ' ').replace(/\s+/g, ' ').trim();

    // Check if title contains any of the anime names
    const nameMatch = namePatterns.some(pattern => titleNorm.includes(pattern));
    if (!nameMatch) continue;

    // Check episode match
    const epMatch = epPatterns.some(p => p.test(item.title));
    if (!epMatch) continue;

    // Deduplicate by magnet hash
    if (item.magnet) {
      const hash = item.magnet.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash) {
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
      }
    }

    results.push({
      name: item.title,
      magnet: item.magnet,
      seeders: item.seeders,
      filesize: item.size,
      source: 'nyaa-rss'
    });
  }

  if (results.length) {
    console.log(`  📡 RSS: Found ${results.length} matches in ${rssIndex.length} indexed torrents`);
  }

  return results;
}

module.exports = { startRssFetcher, stopRssFetcher, clearRssIndex, searchRssIndex, getRssStats };
