const axios = require('axios');

const NEKOBT_BASE = 'https://nekobt.to/api/v1';

// ===== Cache: anime name → NekoBT media_id =====
const mediaIdCache = new Map();

// ===== Cache: media_id → torrents (short TTL) =====
const torrentCache = new Map();
const TORRENT_CACHE_TTL = 10 * 60 * 1000; // 10min

function nekobtAxios(apiKey) {
  return axios.create({
    baseURL: NEKOBT_BASE,
    timeout: 15000,
    headers: { Cookie: `ssid=${apiKey}` },
  });
}

// ===== Find NekoBT media_id by anime name =====
async function findMediaId(animeName, apiKey) {
  if (!animeName || !apiKey) return null;

  const cacheKey = animeName.toLowerCase().trim();
  if (mediaIdCache.has(cacheKey)) return mediaIdCache.get(cacheKey);

  try {
    const client = nekobtAxios(apiKey);
    const resp = await client.get('/media/search', { params: { query: animeName, limit: 5 } });
    const results = resp.data?.data;
    if (!results?.length) {
      console.log(`  🐱 NekoBT: no media for "${animeName}"`);
      mediaIdCache.set(cacheKey, null);
      return null;
    }

    // Best match: prefer exact title match, then first result
    const exact = results.find(r =>
      r.title?.toLowerCase() === cacheKey ||
      (r.alternate_titles || []).some(t => t.toLowerCase() === cacheKey)
    );
    const media = exact || results[0];
    const mediaId = media.id; // e.g. "s77"
    console.log(`  🐱 NekoBT: "${animeName}" → ${mediaId} "${media.title}"`);

    mediaIdCache.set(cacheKey, mediaId);
    return mediaId;
  } catch (err) {
    if (err.response?.status === 429) {
      const retryAfter = err.response?.data?.retry_after || 5;
      console.log(`  🐱 NekoBT: rate limited, retry after ${retryAfter}s`);
    } else if (err.response?.status === 401) {
      console.log(`  🐱 NekoBT: unauthorized (invalid API key)`);
    } else {
      console.log(`  🐱 NekoBT media search error: ${err.message}`);
    }
    return null;
  }
}

// ===== Find media_id by TVDB/TMDB/IMDb ID (via /media/<id> or search) =====
async function findMediaIdByExternalIds(externalIds, apiKey) {
  if (!apiKey) return null;

  // externalIds = { tvdbId, tmdbId, imdbId, names[] }
  // Strategy: search by name, then verify external IDs match
  const { names, tvdbId, tmdbId, imdbId } = externalIds;

  for (const name of (names || [])) {
    const mediaId = await findMediaId(name, apiKey);
    if (mediaId) return mediaId;
  }
  return null;
}

// ===== Fetch single torrent detail (has magnet, infohash) =====
async function getTorrentDetail(torrentId, apiKey) {
  if (!torrentId || !apiKey) return null;
  try {
    const client = nekobtAxios(apiKey);
    const resp = await client.get(`/torrents/${torrentId}`);
    return resp.data?.data || null;
  } catch (err) {
    if (err.response?.status === 429) {
      const retryAfter = err.response?.data?.retry_after || 3;
      console.log(`  🐱 NekoBT: rate limited on torrent detail, retry after ${retryAfter}s`);
      // Wait and retry once
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      try {
        const client2 = nekobtAxios(apiKey);
        const resp2 = await client2.get(`/torrents/${torrentId}`);
        return resp2.data?.data || null;
      } catch { return null; }
    }
    console.log(`  🐱 NekoBT torrent detail error ${torrentId}: ${err.message}`);
    return null;
  }
}

// ===== Search torrents by NekoBT media_id =====
async function searchByMediaId(mediaId, apiKey, options = {}) {
  if (!mediaId || !apiKey) return [];

  const { episodeIds, sort } = options;
  const cacheKey = `${mediaId}:${episodeIds?.join(',') || 'all'}`;

  // Check torrent cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TORRENT_CACHE_TTL) {
    console.log(`  🐱 NekoBT: ${cached.data.length} torrents (cached) for ${mediaId}`);
    return cached.data;
  }

  try {
    const client = nekobtAxios(apiKey);
    const params = {
      media_id: mediaId,
      limit: 50,
      sort_by: sort || 'best',
    };
    if (episodeIds?.length) {
      params.episode_ids = episodeIds.join(',');
      params.episode_match_any = true;
    }

    const resp = await client.get('/torrents/search', { params });
    const results = resp.data?.data || [];

    if (!results.length) {
      console.log(`  🐱 NekoBT: 0 torrents for ${mediaId}`);
      torrentCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    console.log(`  🐱 NekoBT: ${results.length} search results for ${mediaId}, fetching magnets...`);

    // Check if search results already have magnet (API might include them)
    const firstHasMagnet = results[0].magnet || results[0].infohash;

    let torrents;
    if (firstHasMagnet) {
      // Search already includes magnet/infohash — use directly
      torrents = results.map(t => mapTorrent(t));
    } else {
      // Need to fetch torrent details for magnet links
      // Limit to top 15 to avoid rate limiting
      const topResults = results.slice(0, 15);
      torrents = [];

      for (const searchResult of topResults) {
        const detail = await getTorrentDetail(searchResult.id, apiKey);
        if (detail && (detail.magnet || detail.infohash)) {
          torrents.push(mapTorrent({ ...searchResult, ...detail }));
        }
        // Small delay between requests to avoid rate limits
        if (topResults.length > 5) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
      console.log(`  🐱 NekoBT: ${torrents.length}/${topResults.length} torrents with magnets`);
    }

    torrentCache.set(cacheKey, { data: torrents, ts: Date.now() });
    return torrents;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log(`  🐱 NekoBT: rate limited`);
    } else if (err.response?.status === 401) {
      console.log(`  🐱 NekoBT: unauthorized`);
    } else {
      console.log(`  🐱 NekoBT torrent search error: ${err.message}`);
    }
    return [];
  }
}

function mapTorrent(t) {
  return {
    name: t.title || t.auto_title || 'Unknown',
    magnet: t.magnet || null,
    infohash: t.infohash || null,
    seeders: parseInt(t.seeders) || 0,
    leechers: parseInt(t.leechers) || 0,
    filesize: formatFilesize(t.filesize),
    filesizeBytes: parseInt(t.filesize) || 0,
    level: t.level, // subtitle level: -1 to 4
    otl: t.otl || false, // original translation
    mtl: t.mtl || false, // machine translation
    batch: t.batch || false,
    hardsub: t.hardsub || false,
    nekobt: true, // marker for NekoBT source
    nekobtId: t.id,
    groups: (t.groups || []).map(g => g.display_name || g.name).filter(Boolean),
    uploaded_at: t.uploaded_at ? parseInt(t.uploaded_at) : null,
    video_type: t.video_type,
    fsub_lang: t.fsub_lang || '',
  };
}

// ===== Get media detail (has episodes with tvdbId for matching) =====
async function getMediaDetail(mediaId, apiKey) {
  if (!mediaId || !apiKey) return null;

  try {
    const client = nekobtAxios(apiKey);
    const resp = await client.get(`/media/${mediaId}`);
    return resp.data?.data || null;
  } catch (err) {
    console.log(`  🐱 NekoBT media detail error: ${err.message}`);
    return null;
  }
}

// ===== Find episode IDs for a specific episode number =====
async function findEpisodeIds(mediaId, apiKey, seasonNum, episodeNum) {
  const detail = await getMediaDetail(mediaId, apiKey);
  if (!detail?.episodes?.length) return [];

  // Match by season + episode number
  const matches = detail.episodes.filter(ep =>
    ep.season === seasonNum && ep.episode === episodeNum
  );

  if (matches.length) {
    return matches.map(ep => String(ep.id));
  }

  // Fallback: match by absolute episode number (season 0 or 1)
  const absMatches = detail.episodes.filter(ep =>
    (ep.season === 0 || ep.season === 1) && ep.episode === episodeNum
  );
  if (absMatches.length) {
    return absMatches.map(ep => String(ep.id));
  }

  // Fallback: match by absolute position
  const absByIndex = detail.episodes.filter(ep => ep.absolute === episodeNum);
  if (absByIndex.length) {
    return absByIndex.map(ep => String(ep.id));
  }

  return [];
}

// ===== Full search pipeline =====
async function searchNekobt(names, apiKey, season, episode, isMovie) {
  if (!apiKey || !names?.length) return [];

  // 1. Find media_id
  let mediaId = null;
  for (const name of names) {
    mediaId = await findMediaId(name, apiKey);
    if (mediaId) break;
  }
  if (!mediaId) return [];

  // 2. Find episode IDs (if not a movie)
  let episodeIds = [];
  if (!isMovie && episode) {
    episodeIds = await findEpisodeIds(mediaId, apiKey, season || 1, episode);
    if (!episodeIds.length) {
      // Try season 0 (absolute numbering)
      episodeIds = await findEpisodeIds(mediaId, apiKey, 0, episode);
    }
    console.log(`  🐱 NekoBT: episode IDs for S${season || 1}E${episode}: [${episodeIds.join(', ')}]`);
  }

  // 3. Search torrents
  const torrents = await searchByMediaId(mediaId, apiKey, { episodeIds });

  // 4. If episode-specific search returned nothing, try without episode filter
  if (!torrents.length && episodeIds.length) {
    console.log(`  🐱 NekoBT: no episode-specific results, trying all torrents`);
    return await searchByMediaId(mediaId, apiKey, {});
  }

  return torrents;
}

// ===== Validate API key =====
async function validateApiKey(apiKey) {
  if (!apiKey) return null;
  try {
    const client = nekobtAxios(apiKey);
    const resp = await client.get('/users/@me');
    const user = resp.data?.data;
    if (!user) return null;
    return {
      username: user.username || user.display_name || 'Unknown',
      id: user.id,
    };
  } catch (err) {
    if (err.response?.status === 401) return null;
    console.log(`  🐱 NekoBT validate error: ${err.message}`);
    return null;
  }
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

// ===== Sort NekoBT results: prefer level 3-4 (OTL fansubs) =====
function sortNekobtResults(torrents) {
  return [...torrents].sort((a, b) => {
    // Prefer OTL (original translation)
    if (a.otl !== b.otl) return a.otl ? -1 : 1;
    // Prefer higher level (3-4 = OTL fansubs)
    if ((a.level || 0) !== (b.level || 0)) return (b.level || 0) - (a.level || 0);
    // Prefer non-MTL
    if (a.mtl !== b.mtl) return a.mtl ? 1 : -1;
    // More seeders
    return (b.seeders || 0) - (a.seeders || 0);
  });
}

module.exports = {
  findMediaId,
  findMediaIdByExternalIds,
  searchByMediaId,
  getMediaDetail,
  findEpisodeIds,
  searchNekobt,
  validateApiKey,
  sortNekobtResults,
  mediaIdCache,
};
