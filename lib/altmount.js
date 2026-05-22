// lib/altmount.js
// Client for AltMount (usenet virtual FS with SAB-compatible API + WebDAV).
// Parallel implementation to lib/nzbdav.js — same overall flow, different API/WebDAV paths.
//
// Key differences vs NzbDav:
//   - SAB API base:   /sabnzbd/api   (NzbDav: /api)
//   - WebDAV base:     /webdav/complete   (NzbDav: /content/<category>)
//   - Folder naming:   AltMount names the completed folder after the NZB *contents*
//                      (the release name), NOT after our uploaded nzbname. So after
//                      upload we must locate the folder via the history `storage`/`name`
//                      field (matched by nzo_id), then PROPFIND that folder.
//
// Flow per stream click:
//   1. fetchNzb(r2_url)                  → download .nzb.gz from R2 + gunzip → XML buffer
//   2. uploadNzb(buf, jobName)           → POST to /sabnzbd/api, returns nzo_id
//   3. waitForCompletedById(nzo_id)      → poll history until status === Completed
//   4. listVideoFilesForSlot(slot)       → PROPFIND /webdav/complete/<release>/ for video
//   5. proxyStream(req, res, filePath)   → range-proxy WebDAV bytes back to client

const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const FormData = require('form-data');
const { URL } = require('url');

const ALTMOUNT_URL = process.env.ALTMOUNT_URL || ''; // e.g. http://178.104.1.86:8095
const API_KEY = process.env.ALTMOUNT_API_KEY || '';
const WEBDAV_USER = process.env.ALTMOUNT_WEBDAV_USER || 'usenet';
const WEBDAV_PASS = process.env.ALTMOUNT_WEBDAV_PASS || '';
const CATEGORY = process.env.ALTMOUNT_CATEGORY || 'default';
const WEBDAV_BASE = process.env.ALTMOUNT_WEBDAV_BASE || '/webdav/complete';
const POLL_TIMEOUT_MS = parseInt(process.env.ALTMOUNT_POLL_TIMEOUT_MS || '20000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.ALTMOUNT_POLL_INTERVAL_MS || '500', 10);

function isConfigured() {
  return !!(ALTMOUNT_URL && API_KEY && WEBDAV_PASS);
}

/**
 * Deterministic job name from R2 URL — used as nzbname on upload.
 * AltMount renames the folder after NZB contents, but the nzbname still helps
 * us correlate the freshly-created history entry.
 */
function makeJobName(r2Url, imdbHint = '') {
  const hash = crypto.createHash('sha1').update(r2Url).digest('hex').slice(0, 16);
  const prefix = imdbHint ? `${imdbHint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}-` : '';
  return `${prefix}${hash}`;
}

/**
 * Download NZB from R2 and return plain NZB XML buffer.
 * Same logic as nzbdav.js — handles gzip and plain XML, surfaces HTTP errors.
 */
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
    throw new Error(`fetchNzb: HTTP ${resp.status} from R2 — body: ${bodySnippet}`);
  }

  const buf = Buffer.from(resp.data);

  // Gzip magic bytes 1f 8b → decompress
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf);
    } catch (err) {
      throw new Error(`fetchNzb: gunzip failed: ${err.message}`);
    }
  }

  // Plain NZB XML?
  const head = buf.slice(0, 200).toString('utf8');
  if (head.includes('<?xml') || head.includes('<nzb')) return buf;

  // Bencode (torrent) detection — common indexer bug
  if (/^d\d+:/.test(head)) {
    throw new Error('fetchNzb: got TORRENT file instead of NZB (bencode detected) — indexer bug or wrong r2_key');
  }

  const first4 = buf.slice(0, 4).toString('hex');
  const ascii = head.slice(0, 60).replace(/[^\x20-\x7e]/g, '.');
  throw new Error(`fetchNzb: not gzip and not XML (first4=${first4}, ascii="${ascii}")`);
}

/**
 * POST NZB to AltMount SAB API. Returns { nzo_id, duplicate }.
 */
async function uploadNzb(nzbBuf, jobName) {
  const form = new FormData();
  form.append('name', nzbBuf, { filename: `${jobName}.nzb`, contentType: 'application/x-nzb' });

  const url = `${ALTMOUNT_URL}/sabnzbd/api?mode=addfile&apikey=${encodeURIComponent(API_KEY)}&cat=${encodeURIComponent(CATEGORY)}&nzbname=${encodeURIComponent(jobName)}&output=json`;
  const resp = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 15000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  if (resp.data?.status && Array.isArray(resp.data.nzo_ids) && resp.data.nzo_ids.length) {
    return { nzo_id: String(resp.data.nzo_ids[0]), duplicate: false };
  }

  const errMsg = String(resp.data?.error || '').toLowerCase();
  if (errMsg.includes('duplicate') || errMsg.includes('already exist')) {
    return { nzo_id: null, duplicate: true };
  }

  throw new Error(`uploadNzb: bad response: ${JSON.stringify(resp.data).slice(0, 200)}`);
}

/**
 * Fetch the full history slots array.
 */
async function getHistorySlots() {
  const url = `${ALTMOUNT_URL}/sabnzbd/api?mode=history&apikey=${encodeURIComponent(API_KEY)}&output=json&limit=200`;
  const resp = await axios.get(url, { timeout: 8000 });
  return resp.data?.history?.slots || resp.data?.slots || [];
}

/**
 * Find a history slot. Match priority:
 *   1. by nzo_id (most reliable after upload)
 *   2. by nzbname matching our jobName (fallback)
 * Among matches, prefer completed > in-progress > failed.
 */
async function findSlot({ nzoId, jobName }) {
  const slots = await getHistorySlots();
  const matches = slots.filter(s => {
    if (nzoId && String(s.nzo_id) === String(nzoId)) return true;
    if (jobName && (s.nzb_name === `${jobName}.nzb` || s.name === jobName || s.nzb_name === jobName)) return true;
    return false;
  });
  if (!matches.length) return null;

  const completed = matches.find(s => String(s.status || '').toLowerCase() === 'completed');
  if (completed) return completed;
  const inProgress = matches.find(s => {
    const st = String(s.status || '').toLowerCase();
    return st === 'downloading' || st === 'extracting' || st === 'queued' ||
           st === 'verifying' || st === 'repairing' || st === 'fetching';
  });
  if (inProgress) return inProgress;
  return matches[0];
}

/**
 * Delete a history entry by nzo_id (cleanup for stale/failed).
 */
async function deleteHistoryEntry(nzoId) {
  if (!nzoId) return false;
  const url = `${ALTMOUNT_URL}/sabnzbd/api?mode=history&name=delete&value=${encodeURIComponent(nzoId)}&apikey=${encodeURIComponent(API_KEY)}&output=json`;
  try {
    const resp = await axios.get(url, { timeout: 8000 });
    return !!resp.data?.status;
  } catch (e) {
    return false;
  }
}

/**
 * Poll history until the job (by nzo_id or jobName) reaches Completed.
 * Returns the completed slot. Throws on failure or timeout.
 */
async function waitForCompleted({ nzoId, jobName }) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const slot = await findSlot({ nzoId, jobName });
    if (slot) {
      const st = String(slot.status || '').toLowerCase();
      lastStatus = st;
      if (st === 'completed') return slot;
      if (st === 'failed' || st === 'error') {
        throw new Error(`AltMount job failed: ${slot.fail_message || 'unknown error'}`);
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`AltMount job not completed within ${POLL_TIMEOUT_MS}ms (last status: ${lastStatus || 'not found'})`);
}

/**
 * Derive the WebDAV folder path from a completed history slot.
 * AltMount `storage` looks like: /config/mount/complete/Default/<release-name>
 * The WebDAV-visible path is: /webdav/complete/<release-name>/  (category folder
 * "Default" is collapsed away in the WebDAV view per observed structure).
 *
 * We use the slot `name` (release name) as the folder under /webdav/complete/.
 */
function webdavFolderForSlot(slot) {
  // Prefer the release name; AltMount puts each completed download in its own folder.
  const release = slot.name || slot.nzb_name?.replace(/\.nzb$/i, '') || '';
  if (!release) return null;
  return `${WEBDAV_BASE}/${encodeURIComponent(release)}/`;
}

/**
 * PROPFIND a WebDAV folder (Depth: infinity) → list of video files { name, path, size }.
 */
async function listVideoFilesInFolder(folderPath) {
  const auth = 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');
  const resp = await axios.request({
    method: 'PROPFIND',
    url: `${ALTMOUNT_URL}${folderPath}`,
    headers: { Authorization: auth, Depth: 'infinity' },
    timeout: 15000,
    responseType: 'text',
    validateStatus: s => s === 207 || s === 200,
  });

  const xml = resp.data || '';
  const responses = [];
  // AltMount uses <D:...> or <d:...> — handle both via case-insensitive matching.
  const re = /<[Dd]:response>([\s\S]*?)<\/[Dd]:response>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const hrefM = block.match(/<[Dd]:href>([^<]+)<\/[Dd]:href>/);
    const isCollection = /<[Dd]:collection\s*\/?>/.test(block);
    const sizeM = block.match(/<[Dd]:getcontentlength>(\d+)<\/[Dd]:getcontentlength>/);
    if (!hrefM || isCollection) continue;

    let hrefPath;
    try {
      hrefPath = new URL(hrefM[1]).pathname;
    } catch (e) {
      hrefPath = hrefM[1];
    }
    const decoded = decodeURIComponent(hrefPath);
    const name = decoded.split('/').filter(Boolean).pop() || '';
    responses.push({
      name,
      path: hrefPath,
      size: sizeM ? parseInt(sizeM[1], 10) : 0,
    });
  }

  const videoExt = /\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i;
  return responses.filter(f => videoExt.test(f.name));
}

function pickMainVideo(files) {
  if (!files.length) return null;
  return [...files].sort((a, b) => b.size - a.size)[0];
}

/**
 * Pick the matching video file for batch episodes (filename → size → largest).
 * `hints` = { n: filename, s: size } or null.
 */
function pickVideoForRequest(files, hints) {
  if (!files.length) return null;
  if (!hints || (!hints.n && !hints.s)) return pickMainVideo(files);

  if (hints.n) {
    const want = String(hints.n).trim();
    const exact = files.find(f => f.name === want);
    if (exact) return exact;
    try {
      const decodedWant = decodeURIComponent(want);
      if (decodedWant !== want) {
        const exact2 = files.find(f => f.name === decodedWant);
        if (exact2) return exact2;
      }
    } catch (e) {}
  }

  if (hints.s && hints.s > 0) {
    const target = hints.s;
    const tol = target * 0.05;
    const sizeMatch = files
      .filter(f => Math.abs(f.size - target) <= tol)
      .sort((a, b) => Math.abs(a.size - target) - Math.abs(b.size - target))[0];
    if (sizeMatch) return sizeMatch;
  }

  return pickMainVideo(files);
}

// In-flight mutex per jobName — concurrent clicks share one upload/poll.
const inFlightJobs = new Map();

/**
 * Full resolve flow. Returns { jobName, filePath } where filePath is a WebDAV
 * path ready for proxyStream.
 *
 * @param {string} r2Url
 * @param {string} imdbHint
 * @param {object|null} hints - { n: filename, s: size } for batch selection
 */
async function ensureReady(r2Url, imdbHint = '', hints = null) {
  if (!isConfigured()) throw new Error('AltMount not configured');
  const jobName = makeJobName(r2Url, imdbHint);

  let jobReadyP = inFlightJobs.get(jobName);
  if (!jobReadyP) {
    jobReadyP = (async () => {
      const t0 = Date.now();

      // Already in history?
      const existing = await findSlot({ jobName });
      if (existing && String(existing.status || '').toLowerCase() === 'completed') {
        return existing;
      }
      if (existing) {
        const st = String(existing.status || '').toLowerCase();
        if (st === 'downloading' || st === 'extracting' || st === 'queued' ||
            st === 'verifying' || st === 'repairing' || st === 'fetching') {
          console.log(`  📡 AltMount: ${jobName} already in progress (${st}), waiting…`);
          const slot = await waitForCompleted({ nzoId: existing.nzo_id, jobName });
          console.log(`  📡 AltMount: ${jobName} ready (existing) in ${Date.now() - t0}ms`);
          return slot;
        }
        if (st === 'failed' || st === 'error') {
          // Clean stale failure and re-upload fresh
          await deleteHistoryEntry(existing.nzo_id);
        }
      }

      // Fresh upload
      const nzb = await fetchNzb(r2Url);
      const upRes = await uploadNzb(nzb, jobName);
      const slot = await waitForCompleted({ nzoId: upRes.nzo_id, jobName });
      console.log(`  📡 AltMount: ${jobName} ready (fresh) in ${Date.now() - t0}ms`);
      return slot;
    })();
    inFlightJobs.set(jobName, jobReadyP);
    jobReadyP.finally(() => {
      if (inFlightJobs.get(jobName) === jobReadyP) inFlightJobs.delete(jobName);
    });
  }

  const slot = await jobReadyP;

  // Resolve the video file inside the completed folder (per-caller, hints may differ).
  const folder = webdavFolderForSlot(slot);
  if (!folder) throw new Error(`AltMount: cannot derive folder from slot ${jobName}`);
  const files = await listVideoFilesInFolder(folder);
  const picked = pickVideoForRequest(files, hints);
  if (!picked) throw new Error(`AltMount: no video file in folder ${folder}`);
  return { jobName, filePath: picked.path };
}

/**
 * Range-proxy a WebDAV file back to the client.
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
      url: `${ALTMOUNT_URL}${filePath}`,
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
  // debug/testing
  fetchNzb,
  uploadNzb,
  getHistorySlots,
  findSlot,
  deleteHistoryEntry,
  waitForCompleted,
  listVideoFilesInFolder,
  webdavFolderForSlot,
  pickMainVideo,
  pickVideoForRequest,
};
