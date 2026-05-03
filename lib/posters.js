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
const PILL_H = 64;
const PILL_FONT_SIZE = 32;
const BOTTOM_FONT_SIZE = 40;

// ===== Calculate luminance of top portion of poster =====
async function calcTopLuminance(buf) {
  const meta = await sharp(buf).metadata();
  const cropH = Math.floor(meta.height * 0.25);
  const { data, info } = await sharp(buf)
    .extract({ left: 0, top: 0, width: meta.width, height: cropH })
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += channels) {
    total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count++;
  }
  return count ? total / count : 128;
}

// ===== Format top pill text =====
function formatTopPill(schedule) {
  const ep = schedule.episode;
  const epStr = ep ? `S${schedule.season || 1}E${String(ep).padStart(2, '0')}` : '';

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

// ===== Format bottom text data =====
function formatBottomText(schedule) {
  const genre = (schedule.genres && schedule.genres[0]) || null;
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
function buildAnimeOverlay(topText, bottomData, isLightTop) {
  const W = POSTER_W;
  const H = POSTER_H;

  const pillBg = isLightTop ? '#1a1a25' : '#ffffff';
  const pillTextColor = isLightTop ? '#ffffff' : '#1a1a25';

  const charW = PILL_FONT_SIZE * 0.55;
  const textW = topText.length * charW;
  const pillW = Math.round(textW + 80);
  const pillX = Math.round((W - pillW) / 2);

  // Pill: flat top corners, rounded bottom corners
  const r = PILL_H / 2;
  const pillPath = `M ${pillX} 0 L ${pillX + pillW} 0 L ${pillX + pillW} ${PILL_H - r} Q ${pillX + pillW} ${PILL_H} ${pillX + pillW - r} ${PILL_H} L ${pillX + r} ${PILL_H} Q ${pillX} ${PILL_H} ${pillX} ${PILL_H - r} Z`;

  const gradientStart = Math.round(H * 0.45);

  let bottomTextSVG = '';
  if (bottomData) {
    let txt = '';
    if (bottomData.genre && bottomData.rating) txt = `${bottomData.genre} · ★ ${bottomData.rating}`;
    else if (bottomData.genre) txt = bottomData.genre;
    else if (bottomData.rating) txt = `★ ${bottomData.rating}`;

    bottomTextSVG = `<text x="${W / 2}" y="${H - 50}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="${BOTTOM_FONT_SIZE}" font-weight="700" fill="white" text-anchor="middle">${escapeXml(txt)}</text>`;
  }

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="botGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="${(gradientStart / H * 100).toFixed(0)}%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0.94)"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#botGrad)"/>
    <path d="${pillPath}" fill="${pillBg}"/>
    <text x="${W / 2}" y="${PILL_H / 2 + PILL_FONT_SIZE / 3}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="${PILL_FONT_SIZE}" font-weight="700" fill="${pillTextColor}" text-anchor="middle">${escapeXml(topText)}</text>
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

    const luminance = await calcTopLuminance(resized);
    const isLightTop = luminance > 128;

    const topText = formatTopPill(schedule);
    const bottomData = formatBottomText(schedule);
    const overlaySVG = buildAnimeOverlay(topText, bottomData, isLightTop);

    const roundedMask = Buffer.from(`<svg width="${POSTER_W}" height="${POSTER_H}" xmlns="http://www.w3.org/2000/svg"><rect width="${POSTER_W}" height="${POSTER_H}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/></svg>`);

    await sharp(resized)
      .composite([
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

  try { for (const f of fs.readdirSync(POSTERS_DIR)) fs.unlinkSync(path.join(POSTERS_DIR, f)); } catch {}

  for (const s of schedules) {
    const p = await generatePoster(s);
    if (p) { s.generatedPoster = p; ok++; }
  }

  const days = [...new Set(schedules.map(s => s.dayOffset))].filter(d => d > 0).sort();
  for (const day of days) await generatePlaceholder(day);

  console.log(`🖼️ Generated ${ok}/${schedules.length} posters + ${days.length} placeholders (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

module.exports = { generateAllPosters, generatePoster, generatePlaceholder, formatTimeCET };
