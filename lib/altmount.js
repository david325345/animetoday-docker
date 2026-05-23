// lib/altmount.js
// Client for AltMount via its SABnzbd-compatible API + WebDAV (deterministic flow).
//
// Why SAB API instead of /api/nzb/streams:
//   /api/nzb/streams aggregates ALL variants of the same NZB content across uploads
//   (returns N streams, requires probing). SAB API is deterministic: addfile with a
//   fixed category + per-NZB nzbname lands the job in its own subfolder
//   /webdav/complete/<CATEGORY>/<jobName>/, and a PROPFIND of that folder returns
//   exactly the file(s) for THIS job. Clean selection, no aggregation, no probing.
//
//   NOTE: SAB API only accepts a category that exists in AltMount's config (Movies,
//   tv, stremio, …). Arbitrary categories are rejected ("invalid category … not found
//   in configuration"). So we use a fixed CATEGORY (default 'stremio') and rely on the
//   nzbname subfolder for per-NZB isolation.
//
// Flow per stream click:
//   1. fetchNzb(r2_url)              -> .nzb(.gz) from R2 + gunzip -> XML buffer
//   2. uploadNzb(buf, jobName)       -> POST mode=addfile&cat=<CATEGORY>&nzbname=<job>
//   3. waitForCompleted(jobName)     -> poll mode=history until status === "Completed"
//   4. listVideoFiles(jobName)       -> PROPFIND /webdav/complete/<CATEGORY>/<job>/
//   5. pickVideoForRequest(files,h)  -> choose file (filename/size hint, or largest)
//   6. proxyStream(req,res,filePath) -> range-proxy WebDAV bytes back to client
//
// AltMount specifics (verified live, SAB 4.5.0):
//   - SAB base:        /sabnzbd/api?apikey=<KEY>
//   - history slot:    { nzo_id, name, category, status:"Completed", storage, fail_message }
//                      (AltMount may append _1/_2 to `name` on collision; `category` stays clean)
//   - WebDAV base:     /webdav/complete/<category>/<file>.mkv   (auth Basic usenet:<pass>)
//   - cat=<jobName>    -> isolated folder per NZB (avoids cross-upload mixing)

const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const FormData = require('form-data');

const ALTMOUNT_URL = process.env.ALTMOUNT_URL || ''; // e.g. http://178.104.1.86:8095
const API_KEY = process.env.ALTMOUNT_API_KEY || '';
const WEBDAV_USER = process.env.ALTMOUNT_WEBDAV_USER || 'usenet';
const WEBDAV_PASS = process.env.ALTMOUNT_WEBDAV_PASS || '';
const WEBDAV_BASE = process.env.ALTMOUNT_WEBDAV_BASE || '/webdav/complete';
// SAB API only accepts a category that EXISTS in AltMount's config (e.g. Movies, tv,
// stremio) — unlike /api/nzb/streams which creates folders for arbitrary categories.
// So we use a fixed, pre-configured category and isolate per-NZB via the nzbname
// subfolder: /webdav/complete/<CATEGORY>/<jobName>/<jobName>.mkv
const CATEGORY = process.env.ALTMOUNT_CATEGORY || 'stremio';
const POLL_TIMEOUT_MS = parseInt(process.env.ALTMOUNT_POLL_TIMEOUT_MS || '120000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.ALTMOUNT_POLL_INTERVAL_MS || '600', 10);

function isConfigured() {
  return !!(ALTMOUNT_URL && API_KEY && WEBDAV_PASS);
}

function webdavAuthHeader() {
  return 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');
}

// Deterministic per-NZB id from R2 URL. Used as nzbname AND category (isolated folder).
function makeJobName(r2Url, imdbHint = '') {
  const hash = crypto.createHash('sha1').update(r2Url).digest('hex').slice(0, 16);
  const prefix = imdbHint ? `${imdbHint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}` : '';
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

// POST NZB to AltMount SAB API with cat=jobName (isolated folder).
// Returns { nzo_id, duplicate }. duplicate=true means a job with this name/folder
// already exists (caller should skip upload and poll history).
async function uploadNzb(nzbBuf, jobName) {
  const form = new FormData();
  form.append('name', nzbBuf, { filename: `${jobName}.nzb`, contentType: 'application/x-nzb' });

  const url = `${ALTMOUNT_URL}/sabnzbd/api?mode=addfile&apikey=${encodeURIComponent(API_KEY)}` +
    `&cat=${encodeURIComponent(CATEGORY)}&nzbname=${encodeURIComponent(jobName)}&output=json`;

  let resp;
  try {
    resp = await axios.post(url, form, {
      headers: form.getHeaders(),
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new Error(`uploadNzb: network error: ${err.message}`);
  }

  if (resp.data && resp.data.status && Array.isArray(resp.data.nzo_ids) && resp.data.nzo_ids.length) {
    return { nzo_id: resp.data.nzo_ids[0], duplicate: false };
  }

  const errMsg = String((resp.data && resp.data.error) || '').toLowerCase();
  if (errMsg.includes('duplicate') || errMsg.includes('already exist')) {
    return { nzo_id: null, duplicate: true };
  }

  throw new Error(`uploadNzb: bad response (HTTP ${resp.status}): ${JSON.stringify(resp.data).slice(0, 200)}`);
}

// Find a history slot for this jobName. AltMount may append _1/_2 to `name`, so we
// match by name prefix OR category (category stays exactly our jobName).
async function findInHistory(jobName) {
  const url = `${ALTMOUNT_URL}/sabnzbd/api?mode=history&apikey=${encodeURIComponent(API_KEY)}&output=json&limit=200`;
  let resp;
  try {
    resp = await axios.get(url, { timeout: 8000, validateStatus: () => true });
  } catch (err) {
    throw new Error(`findInHistory: ${err.message}`);
  }
  const slots = (resp.data && resp.data.history && resp.data.history.slots) || [];
  // category is now the fixed CATEGORY for every job, so match by name (== jobName,
  // possibly with AltMount's _1/_2 suffix), NOT by category.
  const matches = slots.filter(s =>
    s.name === jobName ||
    s.nzb_name === `${jobName}.nzb` ||
    (typeof s.name === 'string' && s.name.startsWith(jobName))
  );
  if (!matches.length) return null;
  const completed = matches.find(s => String(s.status || '').toLowerCase() === 'completed');
  return completed || matches[0];
}

// Poll history until the job is Completed (or timeout). Returns the slot.
async function waitForCompleted(jobName, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const slot = await findInHistory(jobName);
    if (slot) {
      const status = String(slot.status || '').toLowerCase();
      lastStatus = status;
      if (status === 'completed') return slot;
      if (status === 'failed' || status === 'error') {
        throw new Error(`AltMount job failed: ${slot.fail_message || jobName}`);
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`AltMount job timeout (${jobName}, last status: ${lastStatus || 'not found'})`);
}

// PROPFIND the job's WebDAV folder (Depth: infinity) and return video files
// as [{ path, name, size }]. path is the decoded WebDAV pathname (/webdav/complete/...).
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i;

async function listVideoFiles(jobName) {
  const folderUrl = `${ALTMOUNT_URL}${WEBDAV_BASE}/${encodeURIComponent(CATEGORY)}/${encodeURIComponent(jobName)}/`;
  let resp;
  try {
    resp = await axios.request({
      method: 'PROPFIND',
      url: folderUrl,
      headers: { Authorization: webdavAuthHeader(), Depth: 'infinity' },
      timeout: 12000,
      validateStatus: () => true,
      responseType: 'text',
    });
  } catch (err) {
    throw new Error(`listVideoFiles: ${err.message}`);
  }
  if (resp.status !== 207) {
    throw new Error(`listVideoFiles: PROPFIND HTTP ${resp.status} for ${jobName}`);
  }

  const xml = String(resp.data || '');
  // Parse <D:response> blocks for href + getcontentlength.
  const files = [];
  const respBlocks = xml.split(/<\/?[Dd]:response>/).filter(b => b.includes('href'));
  for (const block of respBlocks) {
    const hrefM = block.match(/<[Dd]:href>([^<]+)<\/[Dd]:href>/);
    if (!hrefM) continue;
    let path;
    try { path = decodeURIComponent(hrefM[1]); } catch (e) { path = hrefM[1]; }
    // strip any scheme://host prefix — keep only the pathname
    path = path.replace(/^https?:\/\/[^/]+/i, '');
    if (!VIDEO_EXT.test(path)) continue;
    const sizeM = block.match(/<[Dd]:getcontentlength>(\d+)<\/[Dd]:getcontentlength>/);
    const size = sizeM ? parseInt(sizeM[1], 10) : 0;
    const name = path.split('/').filter(Boolean).pop() || '';
    files.push({ path, name, size });
  }
  return files;
}

// Pick the video file matching the request.
//   1. exact filename hint (hints.n)
//   2. size hint (hints.s ±5%)
//   3. largest file (single-episode default)
// When AltMount left a duplicate (_1.mkv) in the folder, "largest" still picks a
// valid full file; if a giant all-files blob is present, prefer size/name hints.
function pickVideoForRequest(files, hints) {
  if (!files.length) return null;
  if (files.length === 1) return files[0];

  if (hints && hints.n) {
    const want = String(hints.n).trim();
    let hit = files.find(f => f.name === want);
    if (hit) return hit;
    try {
      const dec = decodeURIComponent(want);
      if (dec !== want) { hit = files.find(f => f.name === dec); if (hit) return hit; }
    } catch (e) {}
    const wantBase = want.replace(VIDEO_EXT, '');
    hit = files.find(f => f.name.includes(want) || want.includes(f.name) || (wantBase && f.name.includes(wantBase)));
    if (hit) return hit;
  }

  if (hints && hints.s && hints.s > 0) {
    const tol = hints.s * 0.05;
    const hit = files
      .filter(f => f.size > 0 && Math.abs(f.size - hints.s) <= tol)
      .sort((a, b) => Math.abs(a.size - hints.s) - Math.abs(b.size - hints.s))[0];
    if (hit) return hit;
  }

  // Largest, but drop giant outlier blobs (>3× the smallest) to avoid all-files concatenations.
  const sizes = files.map(f => f.size).filter(s => s > 0).sort((a, b) => a - b);
  const baseline = sizes.length ? sizes[0] : 0;
  const reasonable = baseline > 0 ? files.filter(f => f.size > 0 && f.size <= baseline * 3) : files;
  const pool = reasonable.length ? reasonable : files;
  return pool.sort((a, b) => b.size - a.size)[0];
}

// In-flight mutex per jobName — concurrent clicks share one upload+poll.
const inFlightJobs = new Map();

// Full resolve flow. Returns { jobName, filePath }.
async function ensureReady(r2Url, imdbHint = '', hints = null) {
  if (!isConfigured()) throw new Error('AltMount not configured');
  const jobName = makeJobName(r2Url, imdbHint);

  let jobReadyP = inFlightJobs.get(jobName);
  if (!jobReadyP) {
    jobReadyP = (async () => {
      const t0 = Date.now();

      // Already in history?
      const existing = await findInHistory(jobName);
      const status = existing ? String(existing.status || '').toLowerCase() : '';

      if (status === 'completed') {
        return; // ready — caller resolves filePath below
      }
      if (existing && ['downloading', 'extracting', 'queued', 'verifying', 'repairing'].includes(status)) {
        console.log(`  📡 AltMount: ${jobName} in progress (${status}), waiting…`);
        await waitForCompleted(jobName);
        return;
      }
      // failed/error or not present → (re)upload
      const nzb = await fetchNzb(r2Url);
      const up = await uploadNzb(nzb, jobName);
      if (up.duplicate) {
        // Folder/job already exists from a concurrent click — just wait for it.
        console.log(`  📡 AltMount: ${jobName} duplicate, waiting for existing job…`);
      }
      await waitForCompleted(jobName);
      console.log(`  📡 AltMount: ${jobName} ready in ${Date.now() - t0}ms`);
    })();
    inFlightJobs.set(jobName, jobReadyP);
    jobReadyP.finally(() => {
      if (inFlightJobs.get(jobName) === jobReadyP) inFlightJobs.delete(jobName);
    });
  }

  await jobReadyP;

  const files = await listVideoFiles(jobName);
  const picked = pickVideoForRequest(files, hints);
  if (!picked) throw new Error(`AltMount: no video file in job ${jobName}`);
  return { jobName, filePath: picked.path };
}

// Existence check for a cached path (small WebDAV GET range).
async function validatePath(filePath) {
  if (!isConfigured() || !filePath) return false;
  const url = `${ALTMOUNT_URL}${filePath}`;
  try {
    const r = await axios.request({
      method: 'GET', url, timeout: 6000,
      headers: { Authorization: webdavAuthHeader(), Range: 'bytes=0-1023' },
      responseType: 'arraybuffer', validateStatus: () => true, maxContentLength: 64 * 1024,
    });
    return r.status === 206 || r.status === 200;
  } catch (e) {
    return false;
  }
}

// Range-proxy a WebDAV file back to the client.
async function proxyStream(req, res, filePath) {
  const url = `${ALTMOUNT_URL}${filePath}`;
  const headers = { Authorization: webdavAuthHeader() };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await axios.request({
      method: 'GET', url, headers,
      responseType: 'stream', validateStatus: () => true, timeout: 30000,
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
  uploadNzb,
  findInHistory,
  waitForCompleted,
  listVideoFiles,
  pickVideoForRequest,
};
