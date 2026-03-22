const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const NZBGEEK_BASE = 'https://api.nzbgeek.info/api';
const ANIME_CAT = '5070'; // TV/Anime category

// ===== Cache =====
const nzbgeekCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15min

// ===== Search by TVDB ID + season + episode =====
async function searchByTVDB(tvdbId, season, episode, apiKey) {
  if (!tvdbId || !apiKey) return [];

  const cacheKey = `tvdb:${tvdbId}:${season}:${episode}`;
  const cached = nzbgeekCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`  📰 NZBgeek: ${cached.data.length} results (cached) for TVDB ${tvdbId} S${season}E${episode}`);
    return cached.data;
  }

  try {
    const params = {
      t: 'tvsearch',
      apikey: apiKey,
      tvdbid: tvdbId,
      season: season,
      ep: episode,
      cat: ANIME_CAT,
      limit: 50,
      extended: 1,
    };

    console.log(`  📰 NZBgeek: searching TVDB ${tvdbId} S${season}E${episode}...`);
    const resp = await axios.get(NZBGEEK_BASE, { params, timeout: 15000 });
    const xml = resp.data;

    const results = await parseNzbResponse(xml, apiKey);
    console.log(`  📰 NZBgeek: ${results.length} NZB results for TVDB ${tvdbId} S${season}E${episode}`);

    nzbgeekCache.set(cacheKey, { data: results, ts: Date.now() });
    return results;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log(`  📰 NZBgeek: rate limited`);
    } else {
      console.log(`  📰 NZBgeek search error: ${err.message}`);
    }
    return [];
  }
}

// ===== Text search fallback (for anime without TVDB ID) =====
async function searchByText(query, apiKey) {
  if (!query || !apiKey) return [];

  const cacheKey = `text:${query}`;
  const cached = nzbgeekCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`  📰 NZBgeek: ${cached.data.length} results (cached) for "${query}"`);
    return cached.data;
  }

  try {
    const params = {
      t: 'search',
      apikey: apiKey,
      q: query,
      cat: ANIME_CAT,
      limit: 50,
      extended: 1,
    };

    console.log(`  📰 NZBgeek: text search "${query}"...`);
    const resp = await axios.get(NZBGEEK_BASE, { params, timeout: 15000 });
    const results = await parseNzbResponse(resp.data, apiKey);
    console.log(`  📰 NZBgeek: ${results.length} NZB results for "${query}"`);

    nzbgeekCache.set(cacheKey, { data: results, ts: Date.now() });
    return results;
  } catch (err) {
    console.log(`  📰 NZBgeek text search error: ${err.message}`);
    return [];
  }
}

// ===== Parse Newznab XML response =====
async function parseNzbResponse(xml, apiKey) {
  if (!xml || typeof xml !== 'string') return [];

  try {
    const parsed = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
    const channel = parsed?.rss?.channel;
    if (!channel) return [];

    let items = channel.item;
    if (!items) return [];
    if (!Array.isArray(items)) items = [items];

    return items.map(item => {
      // Extract GUID — can be URL like "https://api.nzbgeek.info/details/HASH" or plain hash
      let rawGuid = item?.guid?.['_'] || item?.guid || '';
      if (typeof rawGuid === 'object') rawGuid = rawGuid['_'] || '';
      // Extract hash from URL if needed
      const guidHash = rawGuid.replace(/.*\//, '').replace(/[^a-f0-9]/gi, '') || rawGuid;

      // Build NZB download URL: https://api.nzbgeek.info/api?t=get&id=HASH&apikey=KEY
      // This is passed in via apiKey parameter from the calling function
      const nzbUrl = guidHash ? `${NZBGEEK_BASE}?t=get&id=${guidHash}&apikey=${apiKey}` : null;

      // Extract size from enclosure or newznab attrs
      let size = 0;
      if (item?.enclosure?.['$']?.length) {
        size = parseInt(item.enclosure['$'].length) || 0;
      }

      // Extract newznab attributes
      const attrs = {};
      const nzbAttrs = item?.['newznab:attr'] || item?.['nZENDb:attr'] || [];
      const attrList = Array.isArray(nzbAttrs) ? nzbAttrs : [nzbAttrs];
      for (const a of attrList) {
        if (a?.['$']?.name && a?.['$']?.value) {
          attrs[a['$'].name] = a['$'].value;
        }
      }

      if (!size && attrs.size) size = parseInt(attrs.size) || 0;

      return {
        name: item.title || 'Unknown',
        nzb_url: nzbUrl,
        size: size,
        filesize: formatFilesize(size),
        pubDate: item.pubDate || null,
        category: attrs.category || '',
        grabs: parseInt(attrs.grabs) || 0,
        source: 'nzbgeek',
      };
    }).filter(r => r.nzb_url); // Only keep results with NZB URL
  } catch (err) {
    console.log(`  📰 NZBgeek XML parse error: ${err.message}`);
    return [];
  }
}

// ===== Validate API key =====
async function validateApiKey(apiKey) {
  if (!apiKey) return false;
  try {
    // Use caps endpoint — doesn't count against API limits
    const resp = await axios.get(NZBGEEK_BASE, {
      params: { t: 'caps', apikey: apiKey },
      timeout: 10000,
    });
    // If we get valid XML back without error, key is valid
    return resp.status === 200 && resp.data && !resp.data.includes('<error code=');
  } catch {
    return false;
  }
}

// ===== Get NZB download URL with API key =====
function getNzbUrl(guid, apiKey) {
  if (!guid || !apiKey) return null;
  return `${NZBGEEK_BASE}?t=get&apikey=${apiKey}&id=${encodeURIComponent(guid)}`;
}

// ===== Helpers =====
function formatFilesize(bytes) {
  if (!bytes) return '?';
  const n = parseInt(bytes);
  if (isNaN(n)) return '?';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

module.exports = {
  searchByTVDB,
  searchByText,
  validateApiKey,
};
