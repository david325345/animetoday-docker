const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const DOWNLOADING_VIDEO_URL = 'https://raw.githubusercontent.com/david325345/animetoday-docker/main/public/downloading.mp4';
const LOADING_VIDEO_PATH = '/tmp/downloading.mp4';

async function downloadLoadingVideo() {
  try {
    const r = await axios.get(DOWNLOADING_VIDEO_URL, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(LOADING_VIDEO_PATH, Buffer.from(r.data));
    console.log(`✅ Loading video cached (${Math.round(r.data.byteLength / 1024)}KB)`);
  } catch (e) { console.log('⚠️ Loading video download failed:', e.message); }
}
downloadLoadingVideo();

const rdStreamCache = new Map();
const RD_CACHE_TTL = 60 * 60 * 1000;
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

// Find correct link index for episode from selected files
function findEpisodeLinkIndex(info, episode) {
  if (!episode || !info?.files || !info?.links) return 0;

  const videoExts = ['.mkv', '.mp4', '.avi', '.webm', '.flv', '.mov', '.wmv'];
  const selectedFiles = (info.files || [])
    .filter(f => f.selected === 1 && videoExts.some(ext => f.path.toLowerCase().endsWith(ext)));

  if (selectedFiles.length <= 1) return 0;

  const epPad = String(episode).padStart(2, '0');
  const ep3 = String(episode).padStart(3, '0');

  // Try matching episode number in filename
  for (let i = 0; i < selectedFiles.length; i++) {
    const name = (selectedFiles[i].path.split('/').pop() || selectedFiles[i].path);
    const n = name.replace(/[\[\]\(\)_.\-]/g, ' ').replace(/\s+/g, ' ').toLowerCase();

    if (new RegExp(`(?:^|\\s|e|ep)${epPad}(?:\\s|v|\\.|$)`, 'i').test(n)) return i;
    if (new RegExp(`(?:^|\\s|e|ep)${ep3}(?:\\s|v|\\.|$)`, 'i').test(n)) return i;
    if (new RegExp(`s\\d+e${epPad}`, 'i').test(n)) return i;
    if (new RegExp(`episode\\s*${episode}`, 'i').test(n)) return i;
    if (new RegExp(`\\s-\\s${epPad}(?:\\s|\\.|$)`, 'i').test(n)) return i;
  }

  // Fallback: sort by name, pick by episode position
  const sorted = selectedFiles.map((f, i) => ({ f, i })).sort((a, b) => a.f.path.localeCompare(b.f.path));
  const idx = episode - 1;
  if (idx >= 0 && idx < sorted.length) {
    console.log(`  RD: 📂 Ep ${episode} → link #${sorted[idx].i + 1} by sort: ${sorted[idx].f.path.split('/').pop()}`);
    return sorted[idx].i;
  }

  return 0;
}

async function getRDStream(magnet, apiKey, episode = 0) {
  if (!apiKey) return null;

  const cacheKey = getCacheKey(magnet, apiKey) + (episode ? `_ep${episode}` : '');
  const cached = rdStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < RD_CACHE_TTL) return cached.url;

  const magnetHash = magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.toLowerCase();
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  try {
    let torrentId = null;

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

    if (info.data?.links?.length) {
      const linkIdx = findEpisodeLinkIndex(info.data, episode);
      const url = await unrestrictLink(apiKey, info.data.links[Math.min(linkIdx, info.data.links.length - 1)]);
      if (url) {
        console.log(`  RD: ✅ Ready (link ${linkIdx + 1}/${info.data.links.length}${episode ? ` ep${episode}` : ''})`);
        rdStreamCache.set(cacheKey, { url, timestamp: Date.now() });
        return url;
      }
    }

    if (info.data?.status === 'waiting_files_selection') {
      const files = info.data?.files || [];
      if (!files.length) return null;
      const videoExts = ['.mkv', '.mp4', '.avi', '.webm', '.flv', '.mov', '.wmv'];
      const videoFiles = files.filter(f => videoExts.some(ext => f.path.toLowerCase().endsWith(ext)));
      const selected = videoFiles.length > 0 ? videoFiles : files;
      await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
        `files=${selected.map(f => f.id).join(',')}`, { headers, timeout: 10000 });
    }

    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 5000 });

      if (poll.data?.links?.length) {
        const linkIdx = findEpisodeLinkIndex(poll.data, episode);
        const url = await unrestrictLink(apiKey, poll.data.links[Math.min(linkIdx, poll.data.links.length - 1)]);
        if (url) {
          console.log(`  RD: ✅ Ready (link ${linkIdx + 1}/${poll.data.links.length}${episode ? ` ep${episode}` : ''})`);
          rdStreamCache.set(cacheKey, { url, timestamp: Date.now() });
          return url;
        }
      }
      const status = poll.data?.status;
      if (['error', 'dead', 'magnet_error', 'virus'].includes(status)) return null;
      if (['downloading', 'queued', 'compressing', 'uploading'].includes(status)) return null;
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

// ===== Instant Availability Check (batch) =====
async function checkInstantAvailability(rdApiKey, hashes) {
  if (!rdApiKey || !hashes.length) return {};

  // Filter valid hex hashes only (40 chars), convert base32 to hex if needed
  const validHashes = hashes.map(h => {
    if (!h) return null;
    // Already hex (40 chars)
    if (/^[a-f0-9]{40}$/i.test(h)) return h.toLowerCase();
    // Base32 (32 chars) → skip, RD only accepts hex
    if (/^[a-z2-7]{32}$/i.test(h)) return null;
    // Short hex (less common)
    if (/^[a-f0-9]{32}$/i.test(h)) return h.toLowerCase();
    return h.toLowerCase();
  }).filter(Boolean);

  console.log(`  ⚡ RD check: ${hashes.length} input, ${validHashes.length} valid hex (sample: ${hashes[0]?.substring(0,20)}... len=${hashes[0]?.length})`);
  if (!validHashes.length) return {};

  try {
    // RD has URL length limits, batch max ~50 hashes
    const batchSize = Math.min(validHashes.length, 50);
    const batch = validHashes.slice(0, batchSize);
    const hashPath = batch.join('/');

    const resp = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashPath}`, {
      headers: { Authorization: `Bearer ${rdApiKey}` },
      timeout: 10000
    });

    const result = {};
    const keys = Object.keys(resp.data || {});
    console.log(`  ⚡ RD response: ${keys.length} hashes returned (sent ${batch.length})`);
    for (const [hash, data] of Object.entries(resp.data || {})) {
      const rd = data?.rd;
      const isCached = !!(rd && Array.isArray(rd) && rd.length > 0);
      result[hash.toLowerCase()] = isCached;
      if (isCached) console.log(`  ⚡ CACHED: ${hash.substring(0, 16)}...`);
    }
    return result;
  } catch (err) {
    // 404 might mean the endpoint doesn't exist or no hashes found — not an error
    if (err.response?.status === 404) return {};
    console.error(`  ⚡ RD instant check error: ${err.message}`);
    return {};
  }
}

module.exports = { getRDStream, rdStreamCache, rdInProgress, getCacheKey, serveLoadingVideo, DOWNLOADING_VIDEO_URL, checkInstantAvailability };
