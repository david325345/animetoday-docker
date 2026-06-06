const axios = require('axios');
const zlib = require('zlib');

const TB_API = 'https://api.torbox.app/v1/api';

const tbStreamCache = new Map();
const TB_CACHE_TTL = 60 * 60 * 1000;
const tbInProgress = new Set();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tbStreamCache) if (now - v.timestamp > TB_CACHE_TTL) tbStreamCache.delete(k);
}, 30 * 60 * 1000);

// ===== Check TorBox user status =====
async function getTBStatus(apiKey) {
  try {
    const resp = await axios.get(`${TB_API}/user/me`, {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000
    });
    const d = resp.data?.data;
    if (!d) return null;
    return {
      username: d.email || 'TorBox User',
      plan: d.plan || 0, // 0=free, 1=essential, 2=standard, 3=pro
      premium: d.plan >= 1,
      pro: d.plan >= 3,
      expiration: d.premium_expires_at || null
    };
  } catch { return null; }
}

// ===== Add torrent via magnet =====
async function addTorrent(apiKey, magnet) {
  try {
    const resp = await axios.post(`${TB_API}/torrents/createtorrent`, 
      `magnet=${encodeURIComponent(magnet)}`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    return resp.data?.data?.torrent_id || resp.data?.data?.id || null;
  } catch (err) {
    console.error(`  TB: addTorrent error: ${err.response?.data?.detail || err.message}`);
    return null;
  }
}

// ===== Get torrent info =====
async function getTorrentInfo(apiKey, torrentId) {
  try {
    const resp = await axios.get(`${TB_API}/torrents/mylist`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { id: torrentId }, timeout: 8000
    });
    return resp.data?.data || null;
  } catch { return null; }
}

// ===== Get torrent stream link =====
async function getTorrentStreamLink(apiKey, torrentId, fileId) {
  try {
    const resp = await axios.get(`${TB_API}/torrents/requestdl`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { token: apiKey, torrent_id: torrentId, file_id: fileId, zip_link: false },
      timeout: 10000
    });
    return resp.data?.data || null;
  } catch (err) {
    console.error(`  TB: requestdl error: ${err.response?.data?.detail || err.message}`);
    return null;
  }
}

// ===== Add NZB to TorBox =====
// NZBgeek: send URL directly (link parameter)
// AnimeTosho: download .nzb.gz, decompress, upload file
async function addNZB(apiKey, nzbUrl, torrentName = '') {
  try {
    const isDirectLink = nzbUrl.includes('nzbgeek') || nzbUrl.includes('apikey=');

    if (isDirectLink) {
      // === Direct URL method (NZBgeek) ===
      console.log(`  TB: NZB via link: ${nzbUrl.substring(0, 80)}...`);
      const resp = await axios.post(`${TB_API}/usenet/createusenetdownload`,
        `link=${encodeURIComponent(nzbUrl)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 60000
        }
      );
      return resp.data?.data?.usenetdownload_id || resp.data?.data?.id || null;
    } else {
      // === File upload method (AnimeTosho .nzb.gz) ===
      const dlResp = await axios.get(nzbUrl, { responseType: 'arraybuffer', timeout: 30000 });
      let nzbData = Buffer.from(dlResp.data);

      // Decompress if gzipped
      try { nzbData = zlib.gunzipSync(nzbData); } catch {}

      let filename = torrentName ? torrentName.replace(/[^a-zA-Z0-9_\-\[\]\(\) .]/g, '_').substring(0, 200) + '.nzb' : 'upload.nzb';

      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', nzbData, { filename, contentType: 'application/x-nzb' });

      const resp = await axios.post(`${TB_API}/usenet/createusenetdownload`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
        timeout: 60000
      });
      return resp.data?.data?.usenetdownload_id || resp.data?.data?.id || null;
    }
  } catch (err) {
    console.error(`  TB: addNZB error: ${err.response?.data?.detail || err.message}`);
    return null;
  }
}

// ===== Get NZB download info =====
async function getNZBInfo(apiKey, nzbId) {
  try {
    const resp = await axios.get(`${TB_API}/usenet/mylist`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { id: nzbId }, timeout: 8000
    });
    return resp.data?.data || null;
  } catch { return null; }
}

// ===== Get NZB stream link =====
async function getNZBStreamLink(apiKey, nzbId, fileId) {
  try {
    const resp = await axios.get(`${TB_API}/usenet/requestdl`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { token: apiKey, usenet_id: nzbId, file_id: fileId, zip_link: false },
      timeout: 10000
    });
    return resp.data?.data || null;
  } catch (err) {
    console.error(`  TB: NZB requestdl error: ${err.response?.data?.detail || err.message}`);
    return null;
  }
}

// ===== Find existing torrent by infohash (for reuse) =====
async function findTBTorrentByHash(apiKey, magnetHash) {
  if (!magnetHash) return null;
  try {
    const resp = await axios.get(`${TB_API}/torrents/mylist`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { bypass_cache: false },
      timeout: 6000
    });
    const list = resp.data?.data || [];
    return list.find(t => (t.hash || '').toLowerCase() === magnetHash) || null;
  } catch { return null; }
}

// ===== Pick the right file from torrent files list =====
// Priority order (best → worst):
//   1. Exact basename match against hint.name           — 99% case for batches
//   2. Exact filesize match against hint.size           — handles renames
//   3. Filesize within ±0.1% of hint.size               — handles minor remux diffs
//   4. fileIdx (index into TB videoFiles)               — legacy fallback ONLY
//   5. Episode-number regex on filename                 — non-fileIdx legacy path
//
// Background: TB returns files in its own internal order (often size-sorted),
// which does NOT match the torrent metadata order the indexer's `file_index`
// is based on. So `videoFiles[fileIdx]` picks the wrong file. The hint
// (matchedFile.name + matchedFile.size from indexer's file_list) lets us match
// by content rather than position, making playback order-independent.
function pickTBFile(files, episode, isFileIdx, hint = null) {
  const videoExts = ['.mkv', '.mp4', '.avi', '.webm'];
  const videoFiles = (files || []).filter(f =>
    videoExts.some(ext => (f.name || f.short_name || '').toLowerCase().endsWith(ext))
  );
  if (!videoFiles.length) return null;
  if (videoFiles.length === 1) return videoFiles[0];

  const baseOf = (s) => String(s || '').split('/').pop().toLowerCase();

  // 1. Exact basename match — strongest signal
  if (hint?.name) {
    const wantBase = baseOf(hint.name);
    const hit = videoFiles.find(f => baseOf(f.short_name || f.name) === wantBase);
    if (hit) {
      console.log(`  TB pickFile: ✅ basename match (${wantBase})`);
      return hit;
    }
  }

  // 2. Exact size match — file renamed but identical content
  if (hint?.size > 0) {
    const hit = videoFiles.find(f => f.size === hint.size);
    if (hit) {
      console.log(`  TB pickFile: ✅ exact size match (${hint.size} bytes)`);
      return hit;
    }
  }

  // 3. Size within ±0.1% — minor remux variation
  if (hint?.size > 0) {
    const tol = hint.size * 0.001;
    const close = videoFiles
      .map(f => ({ f, diff: Math.abs((f.size || 0) - hint.size) }))
      .filter(x => x.diff > 0 && x.diff <= tol)
      .sort((a, b) => a.diff - b.diff)[0];
    if (close) {
      console.log(`  TB pickFile: ✅ size match ±0.1% (${close.f.size} vs ${hint.size})`);
      return close.f;
    }
  }

  // 4. fileIdx fallback — order-dependent, last resort
  if (isFileIdx) {
    const idx = Math.min(Math.max(0, episode), videoFiles.length - 1);
    const picked = videoFiles[idx];
    console.log(`  TB pickFile: ⚠️ fileIdx fallback [${idx}] (no hint match — TB order may differ from torrent meta)`);
    return picked;
  }

  // 5. Episode number regex (non-fileIdx legacy path)
  if (episode && videoFiles.length > 1) {
    const epPad = String(episode).padStart(2, '0');
    const hit = videoFiles.find(f => {
      const n = (f.name || f.short_name || '').toLowerCase();
      return new RegExp(`e${epPad}|\\b${epPad}\\b`).test(n);
    });
    if (hit) {
      console.log(`  TB pickFile: episode regex match (E${epPad})`);
      return hit;
    }
    const fallback = videoFiles[Math.min(episode - 1, videoFiles.length - 1)] || videoFiles[0];
    console.log(`  TB pickFile: ⚠️ episode index fallback [${episode - 1}]`);
    return fallback;
  }

  console.log(`  TB pickFile: no match strategy applied — defaulting to first video`);
  return videoFiles[0];
}

// ===== Get TorBox torrent stream (full flow with fast-path optimizations) =====
// hint: optional { name, size } from indexer's matchedFile — enables content-based
//       file selection (basename / size match) instead of relying on fileIdx, which
//       is order-dependent and breaks when TB sorts files differently than the
//       torrent metadata. Without a hint, behavior falls back to the legacy fileIdx
//       / episode-regex path (kept for backwards compatibility).
async function getTBStream(magnet, apiKey, episode = 0, isFileIdx = false, hint = null) {
  if (!apiKey) return null;

  const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/i);
  const magnetHash = hashMatch?.[1]?.toLowerCase() || '';
  // Include hint name in cache key so different files of the same torrent don't
  // collide (e.g. same batch streamed for two different episodes).
  const hintKey = hint?.name ? `:n=${hint.name}` : '';
  const cacheKey = `tb:${magnetHash}:${isFileIdx ? 'fi' : ''}${episode}${hintKey}`;

  const cached = tbStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TB_CACHE_TTL) return cached.url;

  try {
    let torrentId = null;

    // FAST PATH: reuse existing torrent if already added by this user
    const existing = await findTBTorrentByHash(apiKey, magnetHash);
    if (existing?.id) {
      torrentId = existing.id;
      // If already complete, skip add+poll entirely — go straight to link
      if ((existing.download_finished || existing.download_state === 'completed') && existing.files?.length) {
        const targetFile = pickTBFile(existing.files, episode, isFileIdx, hint);
        if (targetFile?.id != null) {
          const url = await getTorrentStreamLink(apiKey, torrentId, targetFile.id);
          if (url) {
            console.log(`  TB: ⚡ Reused ready torrent ${torrentId} (${targetFile.short_name || targetFile.name}${isFileIdx ? ` [fi${episode}]` : ''})`);
            tbStreamCache.set(cacheKey, { url, timestamp: Date.now() });
            return url;
          }
        }
      } else {
        console.log(`  TB: ♻️ Reusing torrent ${torrentId} (still processing)`);
      }
    }

    // Add torrent (only if not already in user's list)
    if (!torrentId) {
      torrentId = await addTorrent(apiKey, magnet);
      if (!torrentId) return null;
    }

    // Poll for completion — first check IMMEDIATELY (no sleep) for cached torrents
    for (let i = 0; i < 10; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      const info = await getTorrentInfo(apiKey, torrentId);
      if (!info) continue;

      if (info.download_finished || info.download_state === 'completed' || info.files?.length) {
        const targetFile = pickTBFile(info.files || [], episode, isFileIdx, hint);
        if (!targetFile) continue;
        const url = await getTorrentStreamLink(apiKey, torrentId, targetFile.id);
        if (url) {
          console.log(`  TB: ✅ Torrent ready (file: ${targetFile.short_name || targetFile.name}${isFileIdx ? ` [fi${episode}]` : ''})`);
          tbStreamCache.set(cacheKey, { url, timestamp: Date.now() });
          return url;
        }
      }
    }
    return null;
  } catch (err) {
    console.error(`  TB: Stream error: ${err.message}`);
    return null;
  }
}

// ===== Get TorBox NZB stream (full flow) =====
async function getTBNZBStream(nzbUrl, apiKey, episode = 0, torrentName = '') {
  if (!apiKey || !nzbUrl) return null;

  const cacheKey = `tb-nzb:${nzbUrl}:${episode}`;
  const cached = tbStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TB_CACHE_TTL) return cached.url;

  try {
    const nzbId = await addNZB(apiKey, nzbUrl, torrentName);
    if (!nzbId) return null;

    // Poll for completion — first check IMMEDIATELY (no sleep) for cached NZB
    for (let i = 0; i < 30; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 3000));
      const info = await getNZBInfo(apiKey, nzbId);
      if (!info) continue;

      if (info.download_finished || info.download_state === 'completed' || info.files?.length) {
        const videoExts = ['.mkv', '.mp4', '.avi', '.webm'];
        const files = (info.files || []).filter(f => videoExts.some(ext => (f.name || f.short_name || '').toLowerCase().endsWith(ext)));

        if (!files.length) continue;

        let targetFile = files[0];
        if (episode && files.length > 1) {
          const epPad = String(episode).padStart(2, '0');
          targetFile = files.find(f => {
            const n = (f.name || f.short_name || '').toLowerCase();
            return new RegExp(`e${epPad}|\\b${epPad}\\b`).test(n);
          }) || files[Math.min(episode - 1, files.length - 1)] || files[0];
        }

        const fileId = targetFile.id;
        const url = await getNZBStreamLink(apiKey, nzbId, fileId);
        if (url) {
          console.log(`  TB: ✅ NZB ready (file: ${targetFile.name || targetFile.short_name})`);
          tbStreamCache.set(cacheKey, { url, timestamp: Date.now() });
          return url;
        }
      }
    }
    return null;
  } catch (err) {
    console.error(`  TB: NZB stream error: ${err.message}`);
    return null;
  }
}

// ===== Check TorBox instant cache availability (batch) =====
async function checkTBCached(apiKey, hashes) {
  if (!apiKey || !hashes.length) return {};

  try {
    const t0 = Date.now();
    const resp = await axios.get(`${TB_API}/torrents/checkcached`, {
      params: { hash: hashes.join(','), format: 'object' },
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000
    });

    const data = resp.data?.data || {};
    const cachedCount = Object.keys(data).length;
    console.log(`  ⚡ TB cache: ${cachedCount}/${hashes.length} cached (${Date.now() - t0}ms)`);

    // Return simple hash → true map (missing = not cached)
    const result = {};
    for (const hash of hashes) {
      result[hash.toLowerCase()] = !!data[hash.toLowerCase()];
    }
    return result;
  } catch (err) {
    console.log(`  ⚡ TB cache check error: ${err.message}`);
    return {};
  }
}

module.exports = { getTBStatus, getTBStream, getTBNZBStream, tbStreamCache, tbInProgress, checkTBCached };
