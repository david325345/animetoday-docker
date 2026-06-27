'use strict';
// =============================================================================
// release-parser.js
// Data-driven release-name parser tuned against a ~17k-name corpus exported
// from the indexer (Erai-raws / SubsPlease / ToonsHub / Yameii / Onalrie / ASW /
// DKB / Judas / Gecko / VARYG-scene / Cerberus / crane0922 / ... ).
//
// parseRelease(name) → structured attributes; formatReleaseLine(parsed) → one
// compact line for Stremio. Extracts as much as the name actually contains and
// never invents a value that isn't present.
//
// Performance: every RegExp is compiled ONCE at module load. parseRelease() only
// runs pre-compiled .test()/.exec() — a few microseconds per name, negligible
// next to the indexer/TorBox round-trips. Patterns are ordered most-specific
// first within each category; the first match wins.
// =============================================================================

// First matching [label, regex] pair wins.
function firstMatch(name, table) {
  for (let i = 0; i < table.length; i++) if (table[i][1].test(name)) return table[i][0];
  return null;
}

// ---- RESOLUTION -------------------------------------------------------------
const RES_TAGS = [
  ['2160p', /\b(?:2160p|4k|uhd)\b/i],
  ['1440p', /\b1440p\b/i],
  ['1080p', /\b1080p\b/i],
  ['720p',  /\b720p\b/i],
  ['576p',  /\b576p\b/i],
  ['480p',  /\b480p\b/i],
  ['360p',  /\b360p\b/i],
];
const DIM_RE = /\b(\d{3,4})x(\d{3,4})\b/;
function parseResolution(name) {
  const tag = firstMatch(name, RES_TAGS);
  if (tag) return tag;
  const m = DIM_RE.exec(name);          // map raw dimensions by width, then height
  if (m) {
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (w >= 3000 || h >= 1800) return '2160p';
    if (w >= 1800 || h >= 1000) return '1080p';
    if (w >= 1100 || h >= 700)  return '720p';
    if (w >= 1000 || h >= 560)  return '576p';
    return '480p';
  }
  return null;
}

// ---- SOURCE (specific before generic) ---------------------------------------
const SOURCE_TAGS = [
  ['BD Remux', /\bbd[-. ]?remux\b|\bblu[-. ]?ray[-. ]?remux\b|\bremux\b/i],
  ['BDRip',    /\bbd[-. ]?rip\b/i],
  ['BluRay',   /\bblu[-. ]?ray\b|\bbdmv\b|\bbd\b/i],
  ['WEB-DL',   /\bweb[-. ]?dl\b/i],
  ['WEBRip',   /\bweb[-. ]?rip\b/i],
  ['WEB',      /\bweb\b/i],
  ['HDTV',     /\bhdtv\b/i],
  ['DVD',      /\bdvd(?:rip)?\b/i],
  ['TVRip',    /\btv[-. ]?rip\b/i],
];

// ---- STREAMING PLATFORM -----------------------------------------------------
const PLATFORM_TAGS = [
  ['CR',       /\b(?:cr|crunchyroll)\b/i],
  ['AMZN',     /\b(?:amzn|amazon)\b/i],
  ['NF',       /\b(?:nf|netflix)\b/i],
  ['DSNP',     /\b(?:dsnp|disney\+?)\b/i],
  ['BILI',     /\bbili(?:bili)?\b/i],
  ['HIDIVE',   /\bhidive\b/i],
  ['IQIYI',    /\biqiyi\b/i],
  ['WeTV',     /\bwe?tv\b/i],
  ['ABEMA',    /\bab(?:e)?ma\b/i],
  ['YouTube',  /\bytb\b/i],
  ['B-Global', /\bb-?global\b/i],
];

// ---- VIDEO CODEC (incl. "H 264" VARYG space form) ---------------------------
const VCODEC_TAGS = [
  ['H.265', /\bhevc\b|\bx265\b|\bh[\s.]?265\b/i],
  ['H.264', /\bavc\b|\bx264\b|\bh[\s.]?264\b/i],
  ['AV1',   /\bav1\b/i],
  ['VP9',   /\bvp9\b/i],
  ['XviD',  /\bxvid\b/i],
];

// ---- BIT DEPTH --------------------------------------------------------------
const BITDEPTH_TAGS = [
  ['10-bit', /\b10[-. ]?bit\b|\bhi10p?\b/i],
  ['12-bit', /\b12[-. ]?bit\b/i],
  ['8-bit',  /\b8[-. ]?bit\b/i],
];

// ---- HDR --------------------------------------------------------------------
const HDR_TAGS = [
  ['DV',     /\bdolby[-. ]?vision\b|\bdovi\b/i],
  ['HDR10+', /\bhdr10\+/i],
  ['HDR10',  /\bhdr10\b/i],
  ['HDR',    /\bhdr\b/i],
  ['HLG',    /\bhlg\b/i],
];

// ---- AUDIO CODEC (specific before generic; glued forms via (?![a-z])) --------
const ACODEC_TAGS = [
  ['Atmos',  /\batmos\b/i],
  ['TrueHD', /\btrue[-. ]?hd\b/i],
  ['DTS-HD', /\bdts[-. ]?(?:hd|ma)\b/i],
  ['DTS',    /\bdts\b/i],
  ['DD+',    /\beac3\b|\be-?ac-?3\b|\bddp(?![a-z])|\bdd\+/i],
  ['AC3',    /\bac-?3\b|\bdd(?![a-z+])/i],
  ['FLAC',   /\bflac\b/i],
  ['Opus',   /\bopus\b/i],
  ['AAC',    /\baac(?![a-z])/i],
  ['PCM',    /\bl?pcm\b/i],
  ['MP3',    /\bmp3\b/i],
];

// ---- AUDIO CHANNELS (often glued: AAC2.0, DDP5.1) ---------------------------
const CHANNELS_RE = /(?:\b|aac|ddp|dd|eac3|ac3|flac|opus|truehd|dts(?:hd)?)\s?([0-9])\.([0-9])\b/i;
function parseChannels(name) {
  const m = CHANNELS_RE.exec(name);
  return m ? `${m[1]}.${m[2]}` : null;
}

// ---- AUDIO LAYOUT -----------------------------------------------------------
const DUAL_RE = /\bdual[-. ]?audio\b|\bdual\b/i;
function parseAudioLayout(name) {
  if (DUAL_RE.test(name)) return 'Dual-Audio';
  if (/\bmulti[-. ]?audio\b/i.test(name)) return 'Multi-Audio';
  if (/\bmulti\b(?![-. ]?subs?)/i.test(name)) return 'Multi-Audio'; // bare MULTi (VARYG)
  return null;
}

// ---- SUBS & DUB -------------------------------------------------------------
const SUBS_TAGS = [
  ['Multi-Sub', /\bmulti[-. ]?subs?\b|\bmultisub\b|\bm-?sub\b/i],
  ['Eng-Sub',   /\beng(?:lish)?[-. ]?subs?\b/i],
  ['VOSTFR',    /\bvostfr\b/i],
];
const DUB_RE = /\benglish[-. ]?dub\b|\beng[-. ]?dub\b|\bdubbed\b|\bdub\b/i;

// ---- EDITION / FLAGS --------------------------------------------------------
const FLAG_TAGS = [
  ['REMASTERED', /\bremaster(?:ed)?\b/i],
  ['REPACK',     /\brepack\b/i],
  ['PROPER',     /\bproper\b/i],
  ['Uncensored', /\buncensored\b/i],
];
const BATCH_RE     = /\bbatch\b|\bcomplete\b|\[\d+\s*files?\]/i;
const FILECOUNT_RE = /\[(\d+)\s*files?\]/i;
const WEEKLY_RE    = /\bweekly\b/i;
const VERSION_RE   = /(?<=[\s._\-\d])v([0-9])\b/i;   // 06v2 → 2, v3 → 3
const CRC_RE       = /\[([0-9A-Fa-f]{8})\]/;

// ---- RELEASE GROUP ----------------------------------------------------------
// Priority: leading [Group] > scene trailing -GROUP > first clean [Group] bracket.
// A bracket is a "clean" group only if it is not a CRC and none of its words is a
// technical token — this rejects tech blocks like [1080p WEBRip AV1] / [AAC] /
// [12 files] while still accepting multi-word groups like [MICO XD] / [Anime Time].
const LEADING_GROUP_RE = /^\s*\[([^\]]+)\]/;
const SCENE_GROUP_RE   = /-([A-Za-z][A-Za-z0-9]{1,14})\s*(?:\.(?:mkv|mp4))?\s*(?:\([^)]*\))?\s*$/;
const ALL_BRACKETS_RE  = /\[([^\]]+)\]/g;
// Single-word technical token (anchored). Used to reject tech content as a group.
const TECH_WORD = /^(?:\d{3,4}p|\d{3,4}x\d{3,4}|4k|uhd|hi10p?|\d{1,2}-?bit|aac|opus|flac|ac-?3|eac3|ddp?|dd\+?|dts(?:-?hd|-?ma)?|truehd|atmos|l?pcm|mp3|av1|hevc|avc|vp9|xvid|x26[45]|h\.?26[45]|h|hdr10?\+?|hlg|dolby|vision|dovi|dual|audio|multi|multisub|sub|subs?|m-?sub|eng|english|dub|dubbed|vostfr|batch|complete|weekly|raw|repack|proper|uncensored|remux|bd|bdrip|bdmv|bluray|web|web-?dl|web-?rip|webrip|hdtv|dvd|dvdrip|cr|amzn|amazon|nf|netflix|dsnp|disney|bili|bilibili|hidive|iqiyi|we?tv|ab(?:e)?ma|ytb|crunchyroll|files?|\d+|v\d)$/i;
function cleanGroupToken(tok) {
  if (/^[0-9A-Fa-f]{8}$/.test(tok)) return false;               // CRC, not a group
  const words = tok.split(/[\s\-_.]+/).filter(Boolean);
  if (!words.length) return false;
  for (let i = 0; i < words.length; i++) if (TECH_WORD.test(words[i])) return false;
  return true;
}
// True only when EVERY word is technical (e.g. "1080p WEBRip AV1") — used to
// reject a leading bracket that is a pure tech block rather than a group. Real
// groups that merely contain a tech-ish word (e.g. "Inka-Subs", "Anime Time")
// keep at least one non-tech word and are preserved.
function allTechToken(tok) {
  const words = tok.split(/[\s\-_.]+/).filter(Boolean);
  if (!words.length) return false;
  for (let i = 0; i < words.length; i++) if (!TECH_WORD.test(words[i])) return false;
  return true;
}
function parseGroup(name) {
  let m = LEADING_GROUP_RE.exec(name);
  if (m && !allTechToken(m[1].trim())) return m[1].trim();      // leading [Group] (dominant)
  m = SCENE_GROUP_RE.exec(name);
  if (m && cleanGroupToken(m[1])) return m[1].trim();           // scene -GROUP (VARYG, Pi13…)
  ALL_BRACKETS_RE.lastIndex = 0;                                // first clean bracket anywhere
  let b;
  while ((b = ALL_BRACKETS_RE.exec(name))) {
    const tok = b[1].trim();
    if (cleanGroupToken(tok)) return tok;
  }
  return null;
}

// ---- MAIN -------------------------------------------------------------------
function parseRelease(name) {
  const s = String(name || '');
  const vm = VERSION_RE.exec(s);
  const fc = FILECOUNT_RE.exec(s);
  return {
    resolution:  parseResolution(s),
    source:      firstMatch(s, SOURCE_TAGS),
    platform:    firstMatch(s, PLATFORM_TAGS),
    videoCodec:  firstMatch(s, VCODEC_TAGS),
    bitDepth:    firstMatch(s, BITDEPTH_TAGS),
    hdr:         firstMatch(s, HDR_TAGS),
    audioCodec:  firstMatch(s, ACODEC_TAGS),
    channels:    parseChannels(s),
    audioLayout: parseAudioLayout(s),
    subs:        firstMatch(s, SUBS_TAGS),
    dub:         DUB_RE.test(s),
    flags:       FLAG_TAGS.filter((t) => t[1].test(s)).map((t) => t[0]),
    version:     vm ? 'v' + vm[1] : null,
    batch:       BATCH_RE.test(s),
    fileCount:   fc ? parseInt(fc[1], 10) : null,
    weekly:      WEEKLY_RE.test(s),
    crc:         (CRC_RE.exec(s) || [])[1] || null,
    group:       parseGroup(s),
  };
}

// ---- ONE-LINE FORMATTER -----------------------------------------------------
// Order: [res] · source(+platform) · video(+depth+hdr) · audio(+channels) ·
//        layout/dub · subs · flags · version · [group]
function formatReleaseLine(p, opts) {
  opts = opts || {};
  const sep = opts.sep || ' · ';
  const parts = [];
  // Release group FIRST (shown before quality tags, not at the end)
  if (!opts.skipGroup && p.group) parts.push(`[${p.group}]`);
  if (!opts.skipResolution && p.resolution) parts.push(p.resolution);
  if (p.source) parts.push(p.platform ? `${p.source} ${p.platform}` : p.source);
  else if (p.platform) parts.push(p.platform);
  const v = [p.videoCodec, p.bitDepth, p.hdr].filter(Boolean).join(' ');
  if (v) parts.push(v);
  const a = [p.audioCodec, p.channels].filter(Boolean).join(' ');
  if (a) parts.push(a);
  if (p.audioLayout) parts.push(p.audioLayout);
  else if (p.dub) parts.push('Dub');
  if (p.subs) parts.push(p.subs);
  if (p.version) parts.push(p.version);
  for (let i = 0; i < p.flags.length; i++) parts.push(p.flags[i]);
  if (p.batch && !p.flags.includes('REPACK')) parts.push(p.fileCount ? `Batch (${p.fileCount})` : 'Batch');
  return parts.join(sep);
}

module.exports = { parseRelease, formatReleaseLine };
