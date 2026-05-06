const sharp = require('sharp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const POSTERS_DIR = path.join(__dirname, '..', 'public', 'posters');
try { fs.mkdirSync(POSTERS_DIR, { recursive: true }); } catch {}

const { formatTimeCET } = require('./simkl');

// ===== Poster dimensions =====
const POSTER_W = 500;
const POSTER_H = 750;
const RADIUS = 28;
const PILL_H = 96;          // taller pill (extends down over poster more)
const PILL_FONT_SIZE = 32;
const BOTTOM_FONT_SIZE = 40;
const BOTTOM_TEXT_ALPHA = 0.95;   // mostly opaque for readability
const GRADIENT_START_PCT = 55;    // gradient starts lower (lighter overall)
const GRADIENT_MAX_ALPHA = 0.63;  // 160/255 — gentler darken
const BOTTOM_TEXT_BASELINE = 80;  // pixels from bottom (raised text)

// ===== Calculate average top RGB + luminance (for adaptive pill color) =====
async function calcTopColor(buf) {
  const meta = await sharp(buf).metadata();
  const cropH = Math.floor(meta.height * 0.25);
  const { data, info } = await sharp(buf)
    .extract({ left: 0, top: 0, width: meta.width, height: cropH })
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let totalR = 0, totalG = 0, totalB = 0, count = 0;
  for (let i = 0; i < data.length; i += channels) {
    totalR += data[i];
    totalG += data[i + 1];
    totalB += data[i + 2];
    count++;
  }
  if (!count) return { r: 128, g: 128, b: 128, luminance: 128 };

  const r = totalR / count;
  const g = totalG / count;
  const b = totalB / count;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return { r, g, b, luminance };
}

// ===== Convert RGB to HSL =====
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}

// ===== Convert HSL to RGB =====
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// ===== Compute sampled saturated pill color from top-region average =====
function computePillColor(topColor) {
  const { r, g, b, luminance } = topColor;
  const isLight = luminance > 128;
  const { h, s } = rgbToHsl(r, g, b);

  let newL, newS;
  if (isLight) {
    newL = 0.20;                   // dark variant of poster's hue
    newS = Math.min(1.0, s * 1.3); // boost saturation
  } else {
    newL = 0.92;                   // very light variant
    newS = Math.min(1.0, s * 0.6); // de-saturate light pill (text stays readable)
  }

  const rgb = hslToRgb(h, newS, newL);
  const textColor = isLight ? '#ffffff' : '#1e1432';
  return {
    fill: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    text: textColor,
  };
}

// ===== Format top pill text =====
// ===== Simplify episode label =====
// Indexer provides labels like:
//   "S02E03"                       — single (unchanged)
//   "S02E03-09"                    — range (unchanged)
//   "Movie"                        — unchanged
//   "S02E01-02, E04, E14, E16"     — multi-ep same season → "S02 E01-02,04,14,16"
//   "S01E05, S02E01-12"            — multi-season → "S01E05+S02E01-12"
//   "S00E21, E23"                  — multi-ep S00 → "S00 E21,23"
function simplifyEpisodeLabel(label) {
  if (!label) return '';
  // No comma → already compact
  if (!label.includes(',')) return label;

  const segments = label.split(',').map(s => s.trim());
  const parsed = segments.map(seg => {
    // Match S{NN}E{...} or just E{...}
    const full = seg.match(/^S(\d+)E(.+)$/);
    if (full) return { season: full[1], ep: full[2] };
    const epOnly = seg.match(/^E(.+)$/);
    if (epOnly) return { season: null, ep: epOnly[1] };
    return { season: null, ep: seg };
  });

  // Determine season for E-only segments (inherit from previous)
  let lastSeason = null;
  for (const p of parsed) {
    if (p.season) lastSeason = p.season;
    else if (lastSeason) p.season = lastSeason;
  }

  // Group by season
  const bySeason = {};
  const seasonOrder = [];
  for (const p of parsed) {
    const k = p.season || '';
    if (!(k in bySeason)) { bySeason[k] = []; seasonOrder.push(k); }
    bySeason[k].push(p.ep);
  }

  // Single season → "S{XX} E{a},{b},{c}"
  if (seasonOrder.length === 1) {
    const s = seasonOrder[0];
    const eps = bySeason[s].join(',');
    return s ? `S${s} E${eps}` : `E${eps}`;
  }

  // Multi-season → "S01E05+S02E01-12"
  return seasonOrder.map(s => {
    const eps = bySeason[s].join(',');
    return s ? `S${s}E${eps}` : `E${eps}`;
  }).join('+');
}

function formatTopPill(schedule) {
  // today-added items use indexer-provided label, simplified
  if (schedule.topLabel) return simplifyEpisodeLabel(schedule.topLabel);

  const ep = schedule.episode;
  const seasonNum = schedule.season || 1;
  const epStr = ep ? `S${String(seasonNum).padStart(2, '0')}E${String(ep).padStart(2, '0')}` : '';

  if (schedule.dayOffset === 0) {
    const time = formatTimeCET(schedule.airingAt);
    return epStr ? `${time} · ${epStr}` : time;
  }
  const date = new Date(schedule.airingAt);
  const dateStr = date.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Prague',
    day: '2-digit',
    month: 'short',
  });
  return epStr ? `${dateStr} · ${epStr}` : dateStr;
}

// ===== Genre normalization =====
// Cinemeta returns long genre names like "Sci-Fi & Fantasy". We shorten/normalize.
// Also: every anime has "Animation" as first genre → useless, prefer the second.
const GENRE_SHORTEN = {
  'Sci-Fi & Fantasy': 'Sci-Fi',
  'Action & Adventure': 'Action',
  'War & Politics': 'War',
  'Science Fiction': 'Sci-Fi',
};
function pickGenre(genres) {
  if (!Array.isArray(genres) || !genres.length) return null;
  // Skip generic "Animation"/"Anime" (every anime has these) — pick next meaningful genre
  const SKIP = new Set(['Animation', 'Anime']);
  const filtered = genres.filter(g => !SKIP.has(g));
  const pick = filtered[0] || genres[0];
  return GENRE_SHORTEN[pick] || pick;
}

// ===== Format bottom text data =====
function formatBottomText(schedule) {
  const genre = pickGenre(schedule.genres);
  const rating = schedule.malScore ? parseFloat(schedule.malScore).toFixed(1) : null;
  if (!genre && !rating) return null;
  return { genre, rating };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ===== Build anime poster overlay SVG =====
function buildAnimeOverlay(topText, bottomData, pillColor) {
  const W = POSTER_W;
  const H = POSTER_H;

  const charW = PILL_FONT_SIZE * 0.55;
  const textW = topText.length * charW;
  const pillW = Math.round(textW + 80);
  const pillX = Math.round((W - pillW) / 2);

  // Pill: flat top corners, rounded bottom corners
  const r = PILL_H / 2;
  const pillPath = `M ${pillX} 0 L ${pillX + pillW} 0 L ${pillX + pillW} ${PILL_H - r} Q ${pillX + pillW} ${PILL_H} ${pillX + pillW - r} ${PILL_H} L ${pillX + r} ${PILL_H} Q ${pillX} ${PILL_H} ${pillX} ${PILL_H - r} Z`;

  let bottomTextSVG = '';
  if (bottomData) {
    let txt = '';
    if (bottomData.genre && bottomData.rating) txt = `${bottomData.genre} · ★ ${bottomData.rating}`;
    else if (bottomData.genre) txt = bottomData.genre;
    else if (bottomData.rating) txt = `★ ${bottomData.rating}`;

    bottomTextSVG = `<text x="${W / 2}" y="${H - BOTTOM_TEXT_BASELINE}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="${BOTTOM_FONT_SIZE}" font-weight="700" fill="white" fill-opacity="${BOTTOM_TEXT_ALPHA}" text-anchor="middle">${escapeXml(txt)}</text>`;
  }

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <path d="${pillPath}" fill="${pillColor.fill}"/>
    <text x="${W / 2}" y="${PILL_H / 2 + PILL_FONT_SIZE / 3}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="${PILL_FONT_SIZE}" font-weight="700" fill="${pillColor.text}" text-anchor="middle">${escapeXml(topText)}</text>
    ${bottomTextSVG}
  </svg>`;
}

// ===== Build placeholder SVG for future day separators =====
function buildPlaceholderSVG(dayName, dayAbbr, dateStr) {
  const W = POSTER_W;
  const H = POSTER_H;
  const accentColor = '#E84363';

  const charW = PILL_FONT_SIZE * 0.55;
  const textW = dayName.length * charW;
  const pillW = Math.round(textW + 80);
  const pillX = Math.round((W - pillW) / 2);
  const r = PILL_H / 2;
  const pillPath = `M ${pillX} 0 L ${pillX + pillW} 0 L ${pillX + pillW} ${PILL_H - r} Q ${pillX + pillW} ${PILL_H} ${pillX + pillW - r} ${PILL_H} L ${pillX + r} ${PILL_H} Q ${pillX} ${PILL_H} ${pillX} ${PILL_H - r} Z`;

  const cx = W / 2;
  const cy = H / 2;

  // Bottom: swipe lines + arrow (option #9)
  const bottomY = H - 90;
  const lineW = 6;
  const lines = [
    { x1: cx - 60, x2: cx - 30 },
    { x1: cx - 25, x2: cx + 15 },
    { x1: cx + 20, x2: cx + 70 },
  ];
  const linesSVG = lines.map(l =>
    `<line x1="${l.x1}" y1="${bottomY}" x2="${l.x2}" y2="${bottomY}" stroke="${accentColor}" stroke-width="${lineW}" stroke-linecap="round"/>`
  ).join('');

  const arrowTipX = cx + 90;
  const arrowSize = 16;
  const arrowSVG = `<polygon points="${arrowTipX - arrowSize},${bottomY - arrowSize} ${arrowTipX + arrowSize},${bottomY} ${arrowTipX - arrowSize},${bottomY + arrowSize}" fill="${accentColor}"/>`;

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#282346"/>
        <stop offset="100%" stop-color="#0F0F1E"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="${RADIUS}" ry="${RADIUS}"/>
    <path d="${pillPath}" fill="#ffffff"/>
    <text x="${W / 2}" y="${PILL_H / 2 + PILL_FONT_SIZE / 3}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="${PILL_FONT_SIZE}" font-weight="700" fill="#1a1a25" text-anchor="middle">${escapeXml(dayName)}</text>
    <text x="${cx}" y="${cy - 10}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="120" font-weight="700" fill="${accentColor}" text-anchor="middle">${escapeXml(dayAbbr)}</text>
    <text x="${cx}" y="${cy + 60}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="46" font-weight="500" fill="rgba(220,220,230,0.95)" text-anchor="middle">${escapeXml(dateStr)}</text>
    ${linesSVG}
    ${arrowSVG}
  </svg>`;
}

// ===== Generate poster with overlay for a single anime =====
async function generatePoster(schedule) {
  const posterUrl = schedule.posterUrl;
  if (!posterUrl) return null;

  const outputPath = path.join(POSTERS_DIR, `${schedule.simklId}.png`);

  try {
    const resp = await axios.get(posterUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const resized = await sharp(Buffer.from(resp.data))
      .resize(POSTER_W, POSTER_H, { fit: 'cover' })
      .toBuffer();

    const topColor = await calcTopColor(resized);
    const pillColor = computePillColor(topColor);

    const topText = formatTopPill(schedule);
    const bottomData = formatBottomText(schedule);
    const overlaySVG = buildAnimeOverlay(topText, bottomData, pillColor);

    // Build frosted blur panel for bottom of poster
    const frosted = await buildFrostedPanel(resized);

    const roundedMask = Buffer.from(`<svg width="${POSTER_W}" height="${POSTER_H}" xmlns="http://www.w3.org/2000/svg"><rect width="${POSTER_W}" height="${POSTER_H}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/></svg>`);

    await sharp(resized)
      .composite([
        { input: frosted.buf, top: frosted.top, left: 0 },
        { input: Buffer.from(overlaySVG), top: 0, left: 0 },
        { input: roundedMask, blend: 'dest-in' },
      ])
      .png({ quality: 92 })
      .toFile(outputPath);

    return `/posters/${schedule.simklId}.png`;
  } catch (err) {
    console.error(`  🖼️ Poster error ${schedule.simklId}: ${err.message}`);
    return null;
  }
}

// ===== Frosted panel constants =====
const FROSTED_PANEL_PCT = 0.40;    // panel height (top edge fades smoothly)
const FROSTED_BLUR = 12;
const FROSTED_DARKEN_ALPHA = 0.40;
const FROSTED_FADE_PCT = 0.85;     // most of panel fades — only bottom 15% fully opaque

// ===== Build frosted blur panel buffer =====
async function buildFrostedPanel(posterBuf) {
  const panelH = Math.round(POSTER_H * FROSTED_PANEL_PCT);
  const panelTop = POSTER_H - panelH;

  const cropped = await sharp(posterBuf)
    .extract({ left: 0, top: panelTop, width: POSTER_W, height: panelH })
    .toBuffer();

  const blurred = await sharp(cropped).blur(FROSTED_BLUR).toBuffer();

  const darkenSvg = Buffer.from(
    `<svg width="${POSTER_W}" height="${panelH}" xmlns="http://www.w3.org/2000/svg"><rect width="${POSTER_W}" height="${panelH}" fill="rgba(0,0,0,${FROSTED_DARKEN_ALPHA})"/></svg>`
  );
  const darkened = await sharp(blurred)
    .composite([{ input: darkenSvg, top: 0, left: 0 }])
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Apply alpha gradient directly to raw RGBA buffer — pixel-perfect smooth fade
  const { data, info } = darkened;
  const fadeH = Math.round(panelH * FROSTED_FADE_PCT);
  const channels = info.channels; // 4 (RGBA)

  for (let y = 0; y < panelH; y++) {
    let alphaFactor;
    if (y >= fadeH) {
      alphaFactor = 1.0; // fully opaque below fade region
    } else {
      // Linear fade — even, smooth transition
      alphaFactor = y / fadeH;
    }

    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * channels + 3; // alpha channel
      data[idx] = Math.round(data[idx] * alphaFactor);
    }
  }

  const masked = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  }).png().toBuffer();

  return { buf: masked, top: panelTop };
}

// ===== Generate placeholder for future day =====
async function generatePlaceholder(dayOffset) {
  const outputPath = path.join(POSTERS_DIR, `sep_day${dayOffset}.png`);

  try {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);

    const weekdayLong = date.toLocaleDateString('en-GB', { timeZone: 'Europe/Prague', weekday: 'long' });
    const weekdayAbbr = date.toLocaleDateString('en-GB', { timeZone: 'Europe/Prague', weekday: 'short' }).toUpperCase();
    const dateStr = date.toLocaleDateString('en-GB', { timeZone: 'Europe/Prague', day: '2-digit', month: 'short' });

    const dayName = dayOffset === 1 ? 'Tomorrow' : weekdayLong;
    const svgContent = buildPlaceholderSVG(dayName, weekdayAbbr, dateStr);

    await sharp(Buffer.from(svgContent))
      .png({ quality: 92 })
      .toFile(outputPath);

    return `/posters/sep_day${dayOffset}.png`;
  } catch (err) {
    console.error(`  🖼️ Placeholder error day${dayOffset}: ${err.message}`);
    return null;
  }
}

// ===== Generate all posters for schedule =====
async function generateAllPosters(schedules) {
  console.log(`🖼️ Generating posters for ${schedules.length} entries...`);
  const t0 = Date.now();
  let ok = 0;

  // Clean only anime-today files (sep_day*.png + numeric simklId.png) — keep ta_* (today-added)
  try {
    for (const f of fs.readdirSync(POSTERS_DIR)) {
      if (f.startsWith('ta_')) continue; // preserve today-added posters
      fs.unlinkSync(path.join(POSTERS_DIR, f));
    }
  } catch {}

  for (const s of schedules) {
    const p = await generatePoster(s);
    if (p) { s.generatedPoster = p; ok++; }
  }

  const days = [...new Set(schedules.map(s => s.dayOffset))].filter(d => d > 0).sort();
  for (const day of days) await generatePlaceholder(day);

  console.log(`🖼️ Generated ${ok}/${schedules.length} posters + ${days.length} placeholders (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

module.exports = { generateAllPosters, generatePoster, generatePlaceholder, formatTimeCET };
