const axios = require('axios');
const zlib = require('zlib');

const TB_API = 'https://api.torbox.app/v1/api';

const tbStreamCache = new Map();
const TB_CACHE_TTL = 60 * 60 * 1000;

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

// ===== Add NZB from AnimeTosho URL =====
async function addNZB(apiKey, nzbUrl, torrentName = '') {
  try {
    // Download .nzb.gz from AnimeTosho
    const dlResp = await axios.get(nzbUrl, { responseType: 'arraybuffer', timeout: 15000 });
    let nzbData = Buffer.from(dlResp.data);

    // Decompress if gzipped
    try { nzbData = zlib.gunzipSync(nzbData); } catch {}

    // Use torrent name as filename, fallback to URL-derived name
    let filename = torrentName ? torrentName.replace(/[^a-zA-Z0-9_\-\[\]\(\) .]/g, '_').substring(0, 200) + '.nzb' : 'upload.nzb';

    // Upload NZB to TorBox
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', nzbData, { filename, contentType: 'application/x-nzb' });

    const resp = await axios.post(`${TB_API}/usenet/createusenetdownload`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
      timeout: 30000
    });
    return resp.data?.data?.usenetdownload_id || resp.data?.data?.id || null;
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

// ===== Get TorBox torrent stream (full flow) =====
async function getTBStream(magnet, apiKey, episode = 0) {
  if (!apiKey) return null;

  const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/i);
  const magnetHash = hashMatch?.[1]?.toLowerCase() || '';
  const cacheKey = `tb:${magnetHash}:${episode}`;

  const cached = tbStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TB_CACHE_TTL) return cached.url;

  try {
    // Add torrent
    const torrentId = await addTorrent(apiKey, magnet);
    if (!torrentId) return null;

    // Poll for completion
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const info = await getTorrentInfo(apiKey, torrentId);
      if (!info) continue;

      if (info.download_finished || info.download_state === 'completed' || info.files?.length) {
        // Find video file
        const videoExts = ['.mkv', '.mp4', '.avi', '.webm'];
        const files = (info.files || []).filter(f => videoExts.some(ext => (f.name || f.short_name || '').toLowerCase().endsWith(ext)));

        if (!files.length) continue;

        // Find episode file
        let targetFile = files[0];
        if (episode && files.length > 1) {
          const epPad = String(episode).padStart(2, '0');
          targetFile = files.find(f => {
            const n = (f.name || f.short_name || '').toLowerCase();
            return new RegExp(`e${epPad}|\\b${epPad}\\b`).test(n);
          }) || files[Math.min(episode - 1, files.length - 1)] || files[0];
        }

        const fileId = targetFile.id;
        const url = await getTorrentStreamLink(apiKey, torrentId, fileId);
        if (url) {
          console.log(`  TB: ✅ Torrent ready (file: ${targetFile.name || targetFile.short_name})`);
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

    // Poll for completion (NZB can take longer)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
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

module.exports = { getTBStatus, getTBStream, getTBNZBStream, tbStreamCache };
