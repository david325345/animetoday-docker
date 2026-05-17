// lib/nzbdav.js
// Client for NzbDav (mount-only NZB streaming server with SAB-compatible API + WebDAV).
//
// Flow per stream click:
//   1. fetchNzb(r2_url)            → download .nzb.gz from R2 + gunzip → plain XML buffer
//   2. uploadNzb(buf, jobName)     → POST to SAB API, NzbDav stores under jobName
//   3. waitForCompleted(jobName)   → poll history until status === Completed
//   4. listVideoFiles(jobName)     → PROPFIND /content/stremio/<jobName>/ for .mkv/.mp4
//   5. proxyStream(req, res, jobName, file) → range-proxy WebDAV bytes back to client
//
// Idempotency: jobName is a deterministic hash of r2_url. Re-clicking same stream
// finds existing completed job in history immediately (skip steps 1-3).

const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const FormData = require('form-data');
const { URL } = require('url');

const NZBDAV_URL = process.env.NZBDAV_URL || ''; // e.g. http://nzbdav-h80s8cwkssc8gos4ccw4w8k4:3000
const API_KEY = process.env.NZBDAV_API_KEY || '';
const WEBDAV_USER = process.env.NZBDAV_WEBDAV_USER || 'addon';
const WEBDAV_PASS = process.env.NZBDAV_WEBDAV_PASS || '';
const CATEGORY = process.env.NZBDAV_CATEGORY || 'stremio';
const POLL_TIMEOUT_MS = parseInt(process.env.NZBDAV_POLL_TIMEOUT_MS || '20000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.NZBDAV_POLL_INTERVAL_MS || '500', 10);

function isConfigured() {
  return !!(NZBDAV_URL && API_KEY && WEBDAV_PASS);
}

/**
 * Deterministic job name from R2 URL.
 * Format: "<imdbHint>-<sha1-16>" — visible in NzbDav UI, idempotent across clicks.
 */
function makeJobName(r2Url, imdbHint = '') {
  const hash = crypto.createHash('sha1').update(r2Url).digest('hex').slice(0, 16);
  const prefix = imdbHint ? `${imdbHint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}-` : '';
  return `${prefix}${hash}`;
}

/**
 * Download .nzb.gz from R2 and gunzip in-memory to plain NZB XML buffer.
 */
async function fetchNzb(r2Url) {
  const resp = await axios.get(r2Url, { responseType: 'arraybuffer', timeout: 15000 });
  const gz = Buffer.from(resp.data);
  // R2 always serves .nzb.gz — gunzip unconditionally.
  // If someone ever serves uncompressed, gunzip throws; fall back to raw.
  try {
    return zlib.gunzipSync(gz);
  } catch (err) {
    // Probably already plain XML; sanity check
    const head = gz.slice(0, 64).toString('utf8');
    if (head.includes('<?xml') || head.includes('<nzb')) return gz;
    throw new Error(`fetchNzb: gunzip failed and not plain XML (${err.message})`);
  }
}

/**
 * POST NZB to NzbDav SAB API.
 * @param {Buffer} nzbBuf - plain NZB XML bytes
 * @param {string} jobName - desired stable name (passed as nzbname)
 * @returns {Promise<{nzo_id: string}>}
 */
async function uploadNzb(nzbBuf, jobName) {
  const form = new FormData();
  form.append('name', nzbBuf, { filename: `${jobName}.nzb`, contentType: 'application/x-nzb' });

  const url = `${NZBDAV_URL}/api?mode=addfile&apikey=${encodeURIComponent(API_KEY)}&cat=${encodeURIComponent(CATEGORY)}&nzbname=${encodeURIComponent(jobName)}&output=json`;
  const resp = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 15000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  if (!resp.data?.status || !Array.isArray(resp.data.nzo_ids) || !resp.data.nzo_ids.length) {
    throw new Error(`uploadNzb: bad response: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  return { nzo_id: resp.data.nzo_ids[0] };
}

/**
 * Find a job in history by name. Returns the slot or null.
 */
async function findInHistory(jobName) {
  const url = `${NZBDAV_URL}/api?mode=history&apikey=${encodeURIComponent(API_KEY)}&output=json&limit=200`;
  const resp = await axios.get(url, { timeout: 8000 });
  const slots = resp.data?.history?.slots || resp.data?.slots || [];
  return slots.find(s => s.name === jobName || s.nzb_name === jobName || s.nzo_id === jobName) || null;
}

/**
 * Poll history until job is Completed (or timeout). Returns the history slot.
 */
async function waitForCompleted(jobName, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slot = await findInHistory(jobName);
    if (slot) {
      const status = String(slot.status || '').toLowerCase();
      if (status === 'completed') return slot;
      if (status === 'failed' || status === 'error') {
        throw new Error(`NzbDav job failed: ${slot.fail_message || jobName}`);
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`NzbDav job timeout after ${timeoutMs}ms: ${jobName}`);
}

/**
 * PROPFIND on /content/<category>/<jobName>/ — returns list of video files.
 * Returns array of { name, path, size }.
 */
async function listVideoFiles(jobName) {
  const path = `/content/${encodeURIComponent(CATEGORY)}/${encodeURIComponent(jobName)}/`;
  const auth = 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');
  const resp = await axios.request({
    method: 'PROPFIND',
    url: `${NZBDAV_URL}${path}`,
    headers: { Authorization: auth, Depth: '1' },
    timeout: 8000,
    responseType: 'text',
    validateStatus: s => s === 207 || s === 200,
  });

  const xml = resp.data || '';
  // Parse <D:response> blocks. Each has <D:href>, <D:resourcetype>, <D:getcontentlength>.
  const responses = [];
  const re = /<D:response>([\s\S]*?)<\/D:response>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const hrefM = block.match(/<D:href>([^<]+)<\/D:href>/);
    const isCollection = /<D:collection\s*\/?>/.test(block);
    const sizeM = block.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/);
    if (!hrefM || isCollection) continue;

    // <D:href> contains internal URL like "http://localhost:8080/content/..." — ignore host, keep path.
    let hrefPath;
    try {
      hrefPath = new URL(hrefM[1]).pathname;
    } catch (e) {
      hrefPath = hrefM[1]; // already a path
    }
    // hrefPath is URL-encoded; decode for display, keep raw for proxy use
    const decoded = decodeURIComponent(hrefPath);
    const name = decoded.split('/').filter(Boolean).pop() || '';
    responses.push({
      name,
      path: hrefPath, // raw encoded — safe to append to NZBDAV_URL
      size: sizeM ? parseInt(sizeM[1], 10) : 0,
    });
  }

  // Video files only
  const videoExt = /\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i;
  return responses.filter(f => videoExt.test(f.name));
}

/**
 * Pick the main video file from a list.
 * Heuristic: largest file (samples are tiny, main feature is biggest).
 */
function pickMainVideo(files) {
  if (!files.length) return null;
  return [...files].sort((a, b) => b.size - a.size)[0];
}

/**
 * Range-proxy a WebDAV file to the client response.
 * Forwards Range, returns 206 / 200 with proper headers, streams bytes.
 */
async function proxyStream(req, res, filePath) {
  const auth = 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');
  const headers = { Authorization: auth };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];

  let upstream;
  try {
    upstream = await axios.request({
      method: 'GET',
      url: `${NZBDAV_URL}${filePath}`,
      headers,
      responseType: 'stream',
      // Accept any 2xx/3xx/4xx so we can forward errors too
      validateStatus: () => true,
      timeout: 30000,
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`NzbDav upstream error: ${err.message}`);
    return;
  }

  // Forward status + selected headers
  res.status(upstream.status);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of passthrough) {
    const v = upstream.headers[h];
    if (v) res.setHeader(h, v);
  }
  // Ensure these are always set even if upstream forgot — some clients refuse to play without them.
  if (!upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');
  if (!upstream.headers['content-type']) {
    const lower = filePath.toLowerCase();
    let ct = 'application/octet-stream';
    if (lower.endsWith('.mkv')) ct = 'video/x-matroska';
    else if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) ct = 'video/mp4';
    else if (lower.endsWith('.webm')) ct = 'video/webm';
    else if (lower.endsWith('.avi')) ct = 'video/x-msvideo';
    else if (lower.endsWith('.mov')) ct = 'video/quicktime';
    else if (lower.endsWith('.ts')) ct = 'video/mp2t';
    res.setHeader('Content-Type', ct);
  }
  // Ensure no caching by intermediate proxies
  res.setHeader('Cache-Control', 'no-store');

  upstream.data.on('error', (err) => {
    console.log(`  ⚠️ NzbDav stream error: ${err.message}`);
    if (!res.writableEnded) res.end();
  });
  req.on('close', () => {
    if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy();
  });

  upstream.data.pipe(res);
}

/**
 * Build the proxy URL path component for a job's main video file.
 * Returns null if no video found.
 */
async function resolveStreamPath(jobName) {
  const files = await listVideoFiles(jobName);
  const main = pickMainVideo(files);
  return main ? main.path : null;
}

/**
 * Full resolve flow for a stream click: ensure NZB is uploaded + completed + ready to stream.
 * Returns the WebDAV path of the main video file, ready to be passed to proxyStream.
 *
 * Idempotent: calling twice with same r2_url is a no-op after first time (history lookup hits).
 *
 * @param {string} r2Url
 * @param {string} imdbHint - optional prefix for the jobName (visibility in NzbDav UI)
 * @returns {Promise<{jobName: string, filePath: string}>}
 */
async function ensureReady(r2Url, imdbHint = '') {
  if (!isConfigured()) throw new Error('NzbDav not configured');
  const jobName = makeJobName(r2Url, imdbHint);

  // Fast path: already in history?
  const existing = await findInHistory(jobName);
  if (existing && String(existing.status || '').toLowerCase() === 'completed') {
    const filePath = await resolveStreamPath(jobName);
    if (filePath) return { jobName, filePath };
    // Completed but no video file (unusual) — fall through to re-upload
  }

  // Slow path: fetch NZB, upload, poll, list.
  const t0 = Date.now();
  const nzb = await fetchNzb(r2Url);
  await uploadNzb(nzb, jobName);
  await waitForCompleted(jobName);
  const filePath = await resolveStreamPath(jobName);
  if (!filePath) throw new Error(`No video file in NzbDav job ${jobName}`);
  console.log(`  📡 NzbDav: ${jobName} ready in ${Date.now() - t0}ms (${filePath})`);
  return { jobName, filePath };
}

module.exports = {
  isConfigured,
  makeJobName,
  ensureReady,
  proxyStream,
  // Exposed for tests/debug
  fetchNzb,
  uploadNzb,
  findInHistory,
  waitForCompleted,
  listVideoFiles,
  pickMainVideo,
};
