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

// ===== Auth / Accounts =====
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');
const SUPER_ADMIN = { username: 'David32', password: 'david32534' };
let accounts = {}; // { username: { password, token, role, permissions, created } }

function loadAccounts() {
  try {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch {}
  // Ensure super admin always exists
  if (!accounts[SUPER_ADMIN.username]) {
    const token = crypto.randomBytes(8).toString('hex');
    accounts[SUPER_ADMIN.username] = {
      password: SUPER_ADMIN.password,
      token,
      role: 'superadmin',
      permissions: { torrents: true, nzb: true, nzbdav: true, subtitles: true, catalog: true, ondemand: true, animetoday: true },
      created: new Date().toISOString()
    };
    // Create matching user data file
    const userData = defaultUser();
    userData.indexer_enabled = true;
    userData.indexer_only = true;
    userData.indexer_catalog = true;
    userData.subtitles_enabled = true;
    saveUser(token, userData);
    saveAccounts();
    console.log(`👑 Super admin created: ${SUPER_ADMIN.username} (token: ${token})`);
  } else {
    // Always sync password + role from hardcoded value, and grant full permissions
    // (so a legacy admin account never lacks a newly-added permission like nzbdav).
    accounts[SUPER_ADMIN.username].password = SUPER_ADMIN.password;
    accounts[SUPER_ADMIN.username].role = 'superadmin';
    accounts[SUPER_ADMIN.username].permissions = {
      torrents: true, nzb: true, nzbdav: true,
      subtitles: true, catalog: true, ondemand: true, animetoday: true,
    };
  }

  // Backfill nzbdav:false on non-admin legacy accounts that pre-date this permission.
  // (Pure-additive: never overwrites a value the admin has already set.)
  let backfilled = 0;
  for (const acc of Object.values(accounts)) {
    if (acc.role === 'superadmin') continue;
    if (!acc.permissions || typeof acc.permissions.nzbdav !== 'boolean') {
      acc.permissions = acc.permissions || {};
      acc.permissions.nzbdav = false;
      backfilled++;
    }
  }
  if (backfilled) {
    console.log(`👤 Backfilled nzbdav:false on ${backfilled} legacy account(s)`);
    saveAccounts();
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');
    backupToR2('accounts.json', accounts);
  } catch (err) {
    console.error('Accounts save error:', err.message);
  }
}

function authenticateUser(username, password) {
  const acc = accounts[username];
  if (!acc || acc.password !== password) return null;
  return acc;
}

function getAccountByToken(token) {
  for (const [username, acc] of Object.entries(accounts)) {
    if (acc.token === token) return { username, ...acc };
  }
  return null;
}

function createAccount(username, password, permissions = {}) {
  if (accounts[username]) return null; // already exists
  const token = crypto.randomBytes(8).toString('hex');
  const defaultPerms = { torrents: true, nzb: false, nzbdav: false, subtitles: false, catalog: false, ondemand: true, animetoday: false };
  accounts[username] = {
    password,
    token,
    role: 'user',
    permissions: { ...defaultPerms, ...permissions },
    created: new Date().toISOString()
  };
  // Create user data
  const userData = defaultUser();
  userData.indexer_enabled = true;
  userData.indexer_only = true;
  if (permissions.catalog) userData.indexer_catalog = true;
  if (permissions.subtitles) userData.subtitles_enabled = true;
  saveUser(token, userData);
  saveAccounts();
  console.log(`👤 Account created: ${username} (token: ${token})`);
  return accounts[username];
}

function deleteAccount(username) {
  if (username === SUPER_ADMIN.username) return false; // can't delete super admin
  const acc = accounts[username];
  if (!acc) return false;
  // Remove user data file
  try { fs.unlinkSync(userPath(acc.token)); } catch {}
  userCache.delete(acc.token);
  delete accounts[username];
  saveAccounts();
  console.log(`🗑️ Account deleted: ${username}`);
  return true;
}

function updateAccountPermissions(username, permissions) {
  if (username === SUPER_ADMIN.username) return false; // can't modify super admin
  const acc = accounts[username];
  if (!acc) return false;
  acc.permissions = { ...acc.permissions, ...permissions };
  saveAccounts();
  return true;
}

function toggleAccountActive(username, active) {
  if (username === SUPER_ADMIN.username) return false;
  const acc = accounts[username];
  if (!acc) return false;
  acc.active = active;
  saveAccounts();
  return true;
}

function listAccounts() {
  return Object.entries(accounts).map(([username, acc]) => ({
    username,
    role: acc.role,
    token: acc.token,
    permissions: acc.permissions,
    active: acc.active !== false,
    created: acc.created
  }));
}

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
  // Auth
  loadAccounts, authenticateUser, getAccountByToken, createAccount,
  deleteAccount, updateAccountPermissions, toggleAccountActive, listAccounts,
  SUPER_ADMIN,
};
