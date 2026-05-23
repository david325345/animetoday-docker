// lib/altmount.js
// Client for AltMount's Stremio NZB-streaming API.
//
// AltMount exposes a one-shot endpoint that makes mount-based streaming dramatically
// simpler than the SABnzbd+WebDAV dance NzbDav requires:
//
//   POST /api/nzb/streams?download_key=<sha256(apikey)>   (multipart .nzb upload)
//     -> 200 { streams: [ { url, title, name }, ... ], _queue_status: "completed" }
//
//   GET  /api/files/stream?path=<path>&download_key=<key>
//     -> range-streamable file (206 Partial Content, Accept-Ranges: bytes)
//
// So the whole resolve flow is ONE request (upload NZB -> get ready stream URLs),
// versus NzbDav's three (addfile -> poll history -> PROPFIND folder). Measured ~3x
// faster throughput and ~7x lower first-byte latency than the WebDAV path, and the
// stream endpoint emits Accept-Ranges natively.
//
// download_key is the SHA256 hash of the AltMount API key (computed here so only
// ALTMOUNT_API_KEY needs to live in env).
//
// Flow per stream click:
//   1. fetchNzb(r2_url)              -> download .nzb(.gz) from R2 + gunzip -> XML buffer
//   2. requestStreams(nzbBuf)        -> POST /api/nzb/streams -> streams[]
//   3. pickStream(streams, hints)    -> choose file by name/size (batch) or first (single)
//   4. proxyStream(req, res, path)   -> range-proxy /api/files/stream bytes to client

const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const FormData = require('form-data');
const { URL } = require('url');

const ALTMOUNT_URL = process.env.ALTMOUNT_URL || ''; // e.g. http://178.104.1.86:8095
const API_KEY = process.env.ALTMOUNT_API_KEY || '';
const UPLOAD_TIMEOUT_MS = parseInt(process.env.ALTMOUNT_UPLOAD_TIMEOUT_MS || '30000', 10);

// download_key = SHA256(api_key). Computed once at module load.
const DOWNLOAD_KEY = API_KEY
  ? crypto.createHash('sha256').update(API_KEY).digest('hex')
  : '';

function isConfigured() {
  return !!(ALTMOUNT_URL && API_KEY);
}

// Deterministic job name from R2 URL -- used as the uploaded filename so AltMount
// queue entries are correlatable.
function makeJobName(r2Url, imdbHint = '') {
  const hash = crypto.createHash('sha1').update(r2Url).digest('hex').slice(0, 16);
  const prefix = imdbHint ? `${imdbHint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}-` : '';
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

// POST the NZB to /api/nzb/streams and return the streams array.
// `uploadName` is the multipart filename (jobName, optionally with a retry suffix).
async function requestStreams(nzbBuf, uploadName) {
  const form = new FormData();
  form.append('file', nzbBuf, { filename: `${uploadName}.nzb`, contentType: 'application/x-nzb' });

  const url = `${ALTMOUNT_URL}/api/nzb/streams?download_key=${encodeURIComponent(DOWNLOAD_KEY)}`;
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
    throw new Error(`requestStreams: HTTP ${resp.status}: ${String(body).slice(0, 300)}`);
  }

  const streams = resp.data && resp.data.streams;
  if (!Array.isArray(streams) || streams.length === 0) {
    // AltMount returned completed-but-empty. This happens when a previous queue item
    // with the same upload filename "rotted" — its backing files were deleted but the
    // queue record persists, so AltMount dedups to it and returns null streams.
    // Signal the caller to retry once with a fresh (suffixed) upload name.
    const status = resp.data && resp.data._queue_status;
    const err = new Error(`requestStreams: no streams in response (status=${status}): ${JSON.stringify(resp.data).slice(0, 200)}`);
    err.emptyCompleted = (String(status).toLowerCase() === 'completed');
    throw err;
  }
  return streams;
}

// Extract the decoded `path` query param from a /api/files/stream URL.
function pathFromStreamUrl(streamUrl) {
  try {
    const u = new URL(streamUrl);
    const p = u.searchParams.get('path');
    return p || null;
  } catch (e) {
    const m = String(streamUrl).match(/[?&]path=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
    return null;
  }
}

// Display name for a stream (used for filename hint matching).
function streamName(s) {
  return s.title || s.name || '';
}

// Pick the matching stream for the request.
//
// AltMount returns ALL variants of the same NZB content it has ever processed —
// e.g. if we retried under a fresh name, the response lists both the old (possibly
// rotten) file and the new one. So we must NOT blindly take streams[0].
//
// Priority:
//   1. batch filename hint (hints.n) — exact/substring match on title/name
//   2. uploadName — the file we just uploaded (its path contains uploadName); this
//      avoids picking a stale earlier variant
//   3. size hint (hints.s) if AltMount surfaces a size field
//   4. LAST stream (newest variant) rather than first (oldest/possibly rotten)
function pickStream(streams, hints, uploadName) {
  if (streams.length === 1) return streams[0];

  // 1. Batch filename hint
  if (hints && hints.n) {
    const want = String(hints.n).trim();
    let hit = streams.find(s => streamName(s) === want);
    if (hit) return hit;
    try {
      const decodedWant = decodeURIComponent(want);
      if (decodedWant !== want) {
        hit = streams.find(s => streamName(s) === decodedWant);
        if (hit) return hit;
      }
    } catch (e) {}
    const wantBase = want.replace(/\.[a-z0-9]+$/i, '');
    hit = streams.find(s => {
      const n = streamName(s);
      return n.includes(want) || want.includes(n) || (wantBase && n.includes(wantBase));
    });
    if (hit) return hit;
  }

  // 2. Match the file we just uploaded (path/title contains uploadName).
  if (uploadName) {
    const hit = streams.find(s => {
      const p = pathFromStreamUrl(s.url) || '';
      return p.includes(uploadName) || streamName(s).includes(uploadName);
    });
    if (hit) return hit;
  }

  // 3. Size hint
  if (hints && hints.s && hints.s > 0) {
    const target = hints.s;
    const tol = target * 0.05;
    const withSize = streams
      .map(s => ({ s, size: Number(s.size || s.bytes || s.fileSize || 0) }))
      .filter(x => x.size > 0);
    const sizeHit = withSize
      .filter(x => Math.abs(x.size - target) <= tol)
      .sort((a, b) => Math.abs(a.size - target) - Math.abs(b.size - target))[0];
    if (sizeHit) return sizeHit.s;
  }

  // 4. Fallback: newest variant (last), not oldest (first).
  return streams[streams.length - 1];
}

// In-flight mutex per jobName -- concurrent clicks on the same NZB share one upload.
const inFlightJobs = new Map();

// Full resolve flow. Returns { jobName, filePath }.
async function ensureReady(r2Url, imdbHint = '', hints = null) {
  if (!isConfigured()) throw new Error('AltMount not configured');
  const jobName = makeJobName(r2Url, imdbHint);

  let streamsP = inFlightJobs.get(jobName);
  if (!streamsP) {
    streamsP = (async () => {
      const t0 = Date.now();
      const nzb = await fetchNzb(r2Url);
      try {
        const streams = await requestStreams(nzb, jobName);
        console.log(`  📡 AltMount: ${jobName} -> ${streams.length} stream(s) in ${Date.now() - t0}ms`);
        return { streams, uploadName: jobName };
      } catch (err) {
        // Recycled-rotten item (completed but null streams): retry once with a
        // unique upload name so AltMount creates a fresh queue item instead of
        // deduping to the dead one.
        if (err.emptyCompleted) {
          const freshName = `${jobName}-${Date.now().toString(36)}`;
          console.log(`  📡 AltMount: ${jobName} returned empty; retrying as ${freshName}`);
          const streams = await requestStreams(nzb, freshName);
          console.log(`  📡 AltMount: ${freshName} -> ${streams.length} stream(s) in ${Date.now() - t0}ms (retry)`);
          return { streams, uploadName: freshName };
        }
        throw err;
      }
    })();
    inFlightJobs.set(jobName, streamsP);
    streamsP.then(
      () => setTimeout(() => { if (inFlightJobs.get(jobName) === streamsP) inFlightJobs.delete(jobName); }, 60000),
      () => { if (inFlightJobs.get(jobName) === streamsP) inFlightJobs.delete(jobName); }
    );
  }

  const { streams, uploadName } = await streamsP;
  const picked = pickStream(streams, hints, uploadName);
  const filePath = pathFromStreamUrl(picked.url);
  if (!filePath) {
    throw new Error(`AltMount: could not extract path from stream URL: ${String(picked.url).slice(0, 200)}`);
  }
  return { jobName, filePath };
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

// Quick existence check for a resolved AltMount path (HEAD /api/files/stream).
// Returns true if the file is streamable (2xx/206), false otherwise. Used to
// detect "rotten" cached paths (file deleted / cache expired) before serving.
async function validatePath(filePath) {
  if (!isConfigured() || !filePath) return false;
  const url = `${ALTMOUNT_URL}/api/files/stream?path=${encodeURIComponent(filePath)}&download_key=${encodeURIComponent(DOWNLOAD_KEY)}`;
  try {
    const r = await axios.request({
      method: 'HEAD', url, timeout: 5000, validateStatus: () => true,
    });
    return r.status >= 200 && r.status < 400;
  } catch (e) {
    return false;
  }
}

module.exports = {
  isConfigured,
  makeJobName,
  ensureReady,
  proxyStream,
  validatePath,
  fetchNzb,
  requestStreams,
  pickStream,
  pathFromStreamUrl,
  streamName,
};
