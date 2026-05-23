// lib/altmount.js
// Client for AltMount's Stremio NZB-streaming API (Pattern B from AltMount docs:
// "your addon resolves the NZB and hands it to AltMount").
//
//   POST /api/nzb/streams   (multipart: download_key + category + file)
//     -> 200 { streams: [ { url, title, name } ], _queue_status: "completed" }
//   GET  /api/files/stream?path=<path>&download_key=<key>
//     -> range-streamable file (206, Accept-Ranges: bytes)
//
// KEY DESIGN — one isolated folder per NZB:
//   We pass `category = jobName` (a sha1 of the R2 URL). AltMount then stores the
//   file at /complete/<jobName>/<jobName>.mkv — a folder unique to this NZB. This
//   guarantees the response always contains EXACTLY ONE stream: no mixing with other
//   uploads of the same content, no accumulated historical variants, no need to probe
//   or heuristically pick. The earlier "many streams" problem came from sharing a
//   single category (everything landed in /complete/stremio/ together).
//
// download_key = SHA256(api_key) — sent as a form field (per docs), computed here so
// only ALTMOUNT_API_KEY needs to live in env.
//
// Dedup: AltMount caches by NZB filename within nzb_ttl_hours, so re-submitting the
// same jobName returns the cached stream instantly (no re-download). Our deterministic
// jobName therefore acts as a stable cache key — a feature, not a problem.
//
// Flow:
//   1. fetchNzb(r2_url)            -> .nzb(.gz) from R2 + gunzip -> XML buffer
//   2. requestStreams(buf, job)    -> POST with category=job -> single stream
//   3. proxyStream(req,res,path)   -> range-proxy /api/files/stream

const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const FormData = require('form-data');
const { URL } = require('url');

const ALTMOUNT_URL = process.env.ALTMOUNT_URL || ''; // e.g. http://178.104.1.86:8095
const API_KEY = process.env.ALTMOUNT_API_KEY || '';
const UPLOAD_TIMEOUT_MS = parseInt(process.env.ALTMOUNT_UPLOAD_TIMEOUT_MS || '120000', 10);

// download_key = SHA256(api_key). Computed once at module load.
const DOWNLOAD_KEY = API_KEY
  ? crypto.createHash('sha256').update(API_KEY).digest('hex')
  : '';

function isConfigured() {
  return !!(ALTMOUNT_URL && API_KEY);
}

// Deterministic per-NZB id from the R2 URL. Used as BOTH the upload filename and the
// AltMount category, so each NZB gets its own folder: /complete/<jobName>/<jobName>.mkv
function makeJobName(r2Url, imdbHint = '') {
  const hash = crypto.createHash('sha1').update(r2Url).digest('hex').slice(0, 16);
  const prefix = imdbHint ? `${imdbHint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}` : '';
  // category/folder must be filesystem-safe; keep it alphanumeric.
  return `${prefix}${hash}`;
}

// Download NZB from R2 and return plain NZB XML buffer.
async function fetchNzb(r2Url) {
  let resp;
  try {
    resp = await axios.get(r2Url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: () => true,
      maxRedirects: 5,
    });
  } catch (err) {
    throw new Error(`fetchNzb: network error: ${err.message}`);
  }

  if (resp.status !== 200) {
    const bodySnippet = Buffer.from(resp.data || []).slice(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
    throw new Error(`fetchNzb: HTTP ${resp.status} from R2 -- body: ${bodySnippet}`);
  }

  const buf = Buffer.from(resp.data);

  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf);
    } catch (err) {
      throw new Error(`fetchNzb: gunzip failed: ${err.message}`);
    }
  }

  const head = buf.slice(0, 200).toString('utf8');
  if (head.includes('<?xml') || head.includes('<nzb')) return buf;

  if (/^d\d+:/.test(head)) {
    throw new Error('fetchNzb: got TORRENT file instead of NZB (bencode detected)');
  }

  const first4 = buf.slice(0, 4).toString('hex');
  const ascii = head.slice(0, 60).replace(/[^\x20-\x7e]/g, '.');
  throw new Error(`fetchNzb: not gzip and not XML (first4=${first4}, ascii="${ascii}")`);
}

// POST the NZB to /api/nzb/streams with category=jobName (own folder) and return
// the single stream. Throws on empty/non-200 (with emptyCompleted flag for retry).
async function requestStreams(nzbBuf, jobName) {
  const form = new FormData();
  form.append('download_key', DOWNLOAD_KEY);
  form.append('category', jobName);            // isolated folder per NZB
  form.append('file', nzbBuf, { filename: `${jobName}.nzb`, contentType: 'application/x-nzb' });

  const url = `${ALTMOUNT_URL}/api/nzb/streams`;
  let resp;
  try {
    resp = await axios.post(url, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new Error(`requestStreams: network error: ${err.message}`);
  }

  if (resp.status !== 200) {
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const err = new Error(`requestStreams: HTTP ${resp.status}: ${String(body).slice(0, 300)}`);
    // 408 = download didn't finish in time; caller may surface a loading state.
    err.timeout = (resp.status === 408);
    throw err;
  }

  const streams = resp.data && resp.data.streams;
  if (!Array.isArray(streams) || streams.length === 0) {
    const status = resp.data && resp.data._queue_status;
    const err = new Error(`requestStreams: no streams (status=${status}): ${JSON.stringify(resp.data).slice(0, 200)}`);
    err.emptyCompleted = (String(status).toLowerCase() === 'completed');
    throw err;
  }
  return streams;
}

// Extract the decoded `path` query param from a /api/files/stream URL.
// AltMount may return either a /api/files/stream?path=... URL or a direct /webdav/... URL.
function pathFromStreamUrl(streamUrl) {
  try {
    const u = new URL(streamUrl);
    const p = u.searchParams.get('path');
    if (p) return p;
    // Direct webdav URL form: use the pathname as-is.
    if (u.pathname && (u.pathname.startsWith('/webdav/') || u.pathname.startsWith('/complete/'))) {
      return decodeURIComponent(u.pathname);
    }
    return null;
  } catch (e) {
    const m = String(streamUrl).match(/[?&]path=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
    return null;
  }
}

// In-flight mutex per jobName -- concurrent clicks on the same NZB share one upload.
const inFlightJobs = new Map();

// Full resolve flow. Returns { jobName, filePath }.
// Because category=jobName isolates each NZB into its own folder, the response is
// always a single stream -> we just take streams[0]. No probing, no selection.
async function ensureReady(r2Url, imdbHint = '', hints = null) {
  if (!isConfigured()) throw new Error('AltMount not configured');
  const jobName = makeJobName(r2Url, imdbHint);

  let streamP = inFlightJobs.get(jobName);
  if (!streamP) {
    streamP = (async () => {
      const t0 = Date.now();
      const nzb = await fetchNzb(r2Url);
      const streams = await requestStreams(nzb, jobName);
      const filePath = pathFromStreamUrl(streams[0].url);
      if (!filePath) {
        throw new Error(`AltMount: could not extract path from: ${String(streams[0].url).slice(0, 200)}`);
      }
      console.log(`  📡 AltMount: ${jobName} -> ${filePath.split('/').pop()} in ${Date.now() - t0}ms`);
      return filePath;
    })();
    inFlightJobs.set(jobName, streamP);
    streamP.then(
      () => setTimeout(() => { if (inFlightJobs.get(jobName) === streamP) inFlightJobs.delete(jobName); }, 60000),
      () => { if (inFlightJobs.get(jobName) === streamP) inFlightJobs.delete(jobName); }
    );
  }

  const filePath = await streamP;
  return { jobName, filePath };
}

// Quick existence check for a resolved path (small GET range — HEAD is unreliable on
// AltMount). Returns true if streamable. Used to validate cached paths before serving.
async function validatePath(filePath) {
  if (!isConfigured() || !filePath) return false;
  const url = `${ALTMOUNT_URL}/api/files/stream?path=${encodeURIComponent(filePath)}&download_key=${encodeURIComponent(DOWNLOAD_KEY)}`;
  try {
    const r = await axios.request({
      method: 'GET', url, timeout: 6000,
      headers: { Range: 'bytes=0-1023' },
      responseType: 'arraybuffer',
      validateStatus: () => true,
      maxContentLength: 64 * 1024,
    });
    return r.status === 206 || r.status === 200;
  } catch (e) {
    return false;
  }
}

// Range-proxy an AltMount file back to the client via /api/files/stream.
async function proxyStream(req, res, filePath) {
  const url = `${ALTMOUNT_URL}/api/files/stream?path=${encodeURIComponent(filePath)}&download_key=${encodeURIComponent(DOWNLOAD_KEY)}`;

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];

  let upstream;
  try {
    upstream = await axios.request({
      method: 'GET',
      url,
      headers,
      responseType: 'stream',
      validateStatus: () => true,
      timeout: 30000,
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`AltMount upstream error: ${err.message}`);
    return;
  }

  res.status(upstream.status);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of passthrough) {
    const v = upstream.headers[h];
    if (v) res.setHeader(h, v);
  }
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
  res.setHeader('Cache-Control', 'no-store');

  upstream.data.on('error', (err) => {
    console.log(`  ⚠️ AltMount stream error: ${err.message}`);
    if (!res.writableEnded) res.end();
  });
  req.on('close', () => {
    if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy();
  });

  upstream.data.pipe(res);
}

module.exports = {
  isConfigured,
  makeJobName,
  ensureReady,
  proxyStream,
  validatePath,
  fetchNzb,
  requestStreams,
  pathFromStreamUrl,
};
