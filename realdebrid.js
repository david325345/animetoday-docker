const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const DOWNLOADING_VIDEO_URL = 'https://raw.githubusercontent.com/david325345/animetoday-docker/main/public/downloading.mp4';
const LOADING_VIDEO_PATH = '/tmp/downloading.mp4';

// Download loading video at startup for local serving
async function downloadLoadingVideo() {
  try {
    const r = await axios.get(DOWNLOADING_VIDEO_URL, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(LOADING_VIDEO_PATH, Buffer.from(r.data));
    console.log(`✅ Loading video cached (${Math.round(r.data.byteLength / 1024)}KB)`);
  } catch (e) { console.log('⚠️ Loading video download failed:', e.message); }
}
downloadLoadingVideo();

// Stream cache: per-user
const rdStreamCache = new Map();
const RD_CACHE_TTL = 60 * 60 * 1000;

// Track in-progress conversions to avoid duplicates
const rdInProgress = new Set();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rdStreamCache) if (now - v.timestamp > RD_CACHE_TTL) rdStreamCache.delete(k);
}, 30 * 60 * 1000);

function getCacheKey(magnet, apiKey) {
  return crypto.createHash('md5').update(`${magnet}_${apiKey}`).digest('hex');
}

async function unrestrictLink(apiKey, link) {
  try {
    const resp = await axios.post(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      `link=${encodeURIComponent(link)}`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    return resp.data?.download || null;
  } catch { return null; }
}

async function getRDStream(magnet, apiKey) {
  if (!apiKey) return null;

  const cacheKey = getCacheKey(magnet, apiKey);
  const cached = rdStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < RD_CACHE_TTL) {
    return cached.url;
  }

  const magnetHash = magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  try {
    let torrentId = null;

    // Check existing torrents first
    if (magnetHash) {
      try {
        const existing = await axios.get('https://api.real-debrid.com/rest/1.0/torrents',
          { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 5000 });
        const found = (existing.data || []).find(t => t.hash?.toLowerCase() === magnetHash);
        if (found) { torrentId = found.id; console.log(`  RD: ♻️ Reusing ${torrentId}`); }
      } catch {}
    }

    if (!torrentId) {
      const add = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
        `magnet=${encodeURIComponent(magnet)}`, { headers, timeout: 8000 });
      torrentId = add.data?.id;
      if (!torrentId) return null;
    }

    const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 5000 });

    // Already has links
    if (info.data?.links?.length) {
      const url = await unrestrictLink(apiKey, info.data.links[0]);
      if (url) { rdStreamCache.set(cacheKey, { url, timestamp: Date.now() }); return url; }
    }

    // Select files if needed
    if (info.data?.status === 'waiting_files_selection') {
      const files = info.data?.files || [];
      if (!files.length) return null;
      const videoExts = ['.mkv', '.mp4', '.avi', '.webm', '.flv', '.mov', '.wmv'];
      const videoFiles = files.filter(f => videoExts.some(ext => f.path.toLowerCase().endsWith(ext)));
      const selected = videoFiles.length > 0 ? videoFiles : files;
      await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
        `files=${selected.map(f => f.id).join(',')}`, { headers, timeout: 10000 });
    }

    // Poll
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 5000 });
      if (poll.data?.links?.length) {
        const url = await unrestrictLink(apiKey, poll.data.links[0]);
        if (url) { rdStreamCache.set(cacheKey, { url, timestamp: Date.now() }); return url; }
      }
      const status = poll.data?.status;
      if (['error', 'dead', 'magnet_error', 'virus'].includes(status)) return null;
      if (['downloading', 'queued', 'compressing', 'uploading'].includes(status)) return null; // caller shows loading video
    }
    return null;
  } catch (err) {
    console.error(`  RD: Error - ${err.response?.status || '?'}: ${err.response?.data?.error || err.message}`);
    return null;
  }
}

function serveLoadingVideo(res) {
  if (fs.existsSync(LOADING_VIDEO_PATH)) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fs.statSync(LOADING_VIDEO_PATH).size);
    return fs.createReadStream(LOADING_VIDEO_PATH).pipe(res);
  }
  return res.redirect(302, DOWNLOADING_VIDEO_URL);
}

module.exports = { getRDStream, rdStreamCache, rdInProgress, getCacheKey, serveLoadingVideo, DOWNLOADING_VIDEO_URL };
