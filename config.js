const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const SERVER_CONFIG_PATH = path.join(DATA_DIR, 'server.json');

// Ensure directories
try { fs.mkdirSync(USERS_DIR, { recursive: true }); } catch {}

// R2 backup
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID || '3b9379b61dd9b19bc04ec39ac50352e8'}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || 'cb62c68d2e4147ff9ff94ce2bddd1038',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'be3d739c6be4924c3f20700fd17321d193627b91557d3a14dc0bce915f1fa14b',
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'titulky-cache';
const R2_PREFIX = 'nyaa-anime-today';

// ===== Server config (TMDB key - shared) =====
let serverConfig = { tmdb_api_key: '' };

function loadServerConfig() {
  try {
    serverConfig = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8'));
  } catch {}
}

function saveServerConfig() {
  try {
    fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(serverConfig, null, 2), 'utf8');
    backupToR2('server.json', serverConfig);
  } catch (err) {
    console.error('Server config save error:', err.message);
  }
}

function getTMDBKey() { return serverConfig.tmdb_api_key || ''; }
function setTMDBKey(key) { serverConfig.tmdb_api_key = key; saveServerConfig(); }

// ===== User config =====
const userCache = new Map();

function userPath(token) { return path.join(USERS_DIR, `${token}.json`); }

function defaultUser() {
  return {
    rd_api_key: '', rd_refresh_token: '', rd_client_id: '', rd_client_secret: '',
    hidden_anime: [], created: new Date().toISOString()
  };
}

function getUser(token) {
  if (!token) return null;
  if (userCache.has(token)) return userCache.get(token);
  try {
    const data = JSON.parse(fs.readFileSync(userPath(token), 'utf8'));
    userCache.set(token, data);
    return data;
  } catch { return null; }
}

function saveUser(token, data) {
  try {
    userCache.set(token, data);
    fs.writeFileSync(userPath(token), JSON.stringify(data, null, 2), 'utf8');
    backupToR2(`users/${token}.json`, data);
  } catch (err) {
    console.error(`User save error (${token}):`, err.message);
  }
}

function createUser() {
  const token = crypto.randomBytes(8).toString('hex');
  const data = defaultUser();
  saveUser(token, data);
  console.log(`👤 New user: ${token}`);
  return { token, data };
}

function listUsers() {
  try {
    return fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch { return []; }
}

// ===== R2 backup (async, non-blocking) =====
async function backupToR2(key, data) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${R2_PREFIX}/${key}`,
      Body: JSON.stringify(data, null, 2),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.error(`☁️ R2 backup error (${key}):`, err.message);
  }
}

async function restoreFromR2() {
  console.log('☁️ Checking R2 backup...');

  // Restore server config if missing locally
  if (!fs.existsSync(SERVER_CONFIG_PATH)) {
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `${R2_PREFIX}/server.json` }));
      const body = await resp.Body.transformToString();
      fs.writeFileSync(SERVER_CONFIG_PATH, body, 'utf8');
      serverConfig = JSON.parse(body);
      console.log('☁️ Server config restored from R2');
    } catch {}
  }

  // Restore user configs if missing locally
  try {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET, Prefix: `${R2_PREFIX}/users/`
    }));
    for (const obj of (list.Contents || [])) {
      const filename = obj.Key.split('/').pop();
      const localPath = path.join(USERS_DIR, filename);
      if (!fs.existsSync(localPath)) {
        try {
          const resp = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
          const body = await resp.Body.transformToString();
          fs.writeFileSync(localPath, body, 'utf8');
          console.log(`☁️ Restored user: ${filename}`);
        } catch {}
      }
    }
  } catch (err) {
    console.error('☁️ R2 user restore error:', err.message);
  }
}

module.exports = {
  loadServerConfig, saveServerConfig, getTMDBKey, setTMDBKey,
  getUser, saveUser, createUser, listUsers,
  restoreFromR2, serverConfig,
  RD_OPEN_SOURCE_CLIENT_ID: 'X245A4XAIBGVM',
};
