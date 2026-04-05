const sharp = require('sharp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const POSTERS_DIR = path.join(__dirname, '..', 'public', 'posters');
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');
try { fs.mkdirSync(POSTERS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(ICONS_DIR, { recursive: true }); } catch {}

const { formatTimeCET } = require('./simkl');

// ===== Prepare icons (resize once at startup) =====
const ICON_SIZE = 50;
let anilistIconBuf = null;
let malIconBuf = null;

async function prepareIcons() {
  const anilistSrc = path.join(ICONS_DIR, 'Anilist.png');
  const malSrc = path.join(ICONS_DIR, 'MAL.png');

  if (fs.existsSync(anilistSrc)) {
    anilistIconBuf = await sharp(anilistSrc)
      .resize(ICON_SIZE, ICON_SIZE, { fit: 'contain' })
      .png()
      .toBuffer();
    console.log('🖼️ AniList icon loaded');
  }
  if (fs.existsSync(malSrc)) {
    malIconBuf = await sharp(malSrc)
      .resize(ICON_SIZE, ICON_SIZE, { fit: 'contain' })
      .png()
      .toBuffer();
    console.log('🖼️ MAL icon loaded');
  }
}

// ===== Generate poster with overlay for a single anime =====
async function generatePoster(schedule) {
  const posterUrl = schedule.posterUrl;
  if (!posterUrl) return null;

  const outputPath = path.join(POSTERS_DIR, `${schedule.simklId}.jpg`);
  const timeStr = formatTimeCET(schedule.airingAt);
  const anilistScore = schedule.anilistScore || null;
  const malScoreStr = schedule.malScore ? parseFloat(schedule.malScore).toFixed(1) : null;

  try {
    const resp = await axios.get(posterUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const W = 500, H = 750;

    // === TOP BAR: airing time + episode ===
    const topBarH = 36;
    const topLabel = `${timeStr} · Ep ${schedule.episode}`;

    // === Build badge data ===
    const badges = [];
    if (anilistScore && anilistIconBuf) badges.push({ iconBuf: anilistIconBuf, score: anilistScore });
    if (malScoreStr && malIconBuf) badges.push({ iconBuf: malIconBuf, score: malScoreStr });
    if (!badges.length && anilistScore) badges.push({ iconBuf: null, score: `AL ${anilistScore}` });
    if (!badges.length && malScoreStr) badges.push({ iconBuf: null, score: `MAL ${malScoreStr}` });

    const badgeW = 175, badgeH = 60, gap = 16, radius = 12;
    const bottomBarH = badges.length ? 76 : 0;
    const totalBadgeW = badges.length * badgeW + (badges.length - 1) * gap;
    const badgeStartX = Math.round((W - totalBadgeW) / 2);
    const badgeY = H - bottomBarH + 8;

    // === SVG overlay ===
    const topBarSVG = `
      <rect x="0" y="0" width="${W}" height="${topBarH}" fill="rgba(0,0,0,0.75)"/>
      <text x="${W / 2}" y="25"
            font-family="DejaVu Sans,Noto Sans,sans-serif"
            font-size="20" font-weight="600"
            fill="rgba(255,255,255,0.9)" text-anchor="middle">
        ${topLabel}
      </text>
    `;

    let bottomBarSVG = '';
    let badgeTextSVG = '';
    if (badges.length) {
      bottomBarSVG = `<rect x="0" y="${H - bottomBarH}" width="${W}" height="${bottomBarH}" fill="rgba(0,0,0,0.80)"/>`;
      badgeTextSVG = badges.map((b, i) => {
        const x = badgeStartX + i * (badgeW + gap);
        const textX = b.iconBuf ? x + ICON_SIZE + 14 : x + 10;
        return `
          <rect x="${x}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${radius}" fill="rgba(0,0,0,0.75)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
          <text x="${textX}" y="${badgeY + 41}" font-family="DejaVu Sans,Noto Sans,sans-serif" font-size="30" font-weight="700" fill="white">${b.score}</text>
        `;
      }).join('');
    }

    const svgOverlay = `
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${topBarSVG}
        ${bottomBarSVG}
        ${badgeTextSVG}
      </svg>
    `;

    // === Composite layers ===
    const composites = [{ input: Buffer.from(svgOverlay), top: 0, left: 0 }];

    badges.forEach((b, i) => {
      if (b.iconBuf) {
        const x = badgeStartX + i * (badgeW + gap) + 6;
        const y = badgeY + Math.round((badgeH - ICON_SIZE) / 2);
        composites.push({ input: b.iconBuf, top: y, left: x });
      }
    });

    await sharp(Buffer.from(resp.data))
      .resize(W, H, { fit: 'cover' })
      .composite(composites)
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    return `/posters/${schedule.simklId}.jpg`;
  } catch (err) {
    console.error(`  🖼️ Poster error ${schedule.simklId}: ${err.message}`);
    return null;
  }
}

// ===== Generate separator poster (day divider) =====
async function generateSeparator(dayOffset, label) {
  const outputPath = path.join(POSTERS_DIR, `sep_day${dayOffset}.jpg`);
  const W = 500, H = 750;

  try {
    const svgContent = `
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0d0d1a"/>
            <stop offset="100%" stop-color="#1a1a3e"/>
          </linearGradient>
        </defs>
        <rect width="${W}" height="${H}" fill="url(#bg)"/>
        <line x1="50" y1="${H/2 - 60}" x2="${W-50}" y2="${H/2 - 60}" stroke="rgba(255,77,106,0.4)" stroke-width="2"/>
        <text x="${W/2}" y="${H/2}" font-family="DejaVu Sans,Noto Sans,sans-serif" font-size="32" font-weight="700" fill="#ff4d6a" text-anchor="middle">${label}</text>
        <text x="${W/2}" y="${H/2 + 50}" font-family="DejaVu Sans,Noto Sans,sans-serif" font-size="22" fill="rgba(255,255,255,0.5)" text-anchor="middle">▶ ▶ ▶</text>
        <line x1="50" y1="${H/2 + 80}" x2="${W-50}" y2="${H/2 + 80}" stroke="rgba(255,77,106,0.4)" stroke-width="2"/>
      </svg>
    `;

    await sharp(Buffer.from(svgContent))
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    return `/posters/sep_day${dayOffset}.jpg`;
  } catch (err) {
    console.error(`  🖼️ Separator error day${dayOffset}: ${err.message}`);
    return null;
  }
}

// ===== Generate all posters for schedule =====
async function generateAllPosters(schedules) {
  console.log(`🖼️ Generating posters for ${schedules.length} entries...`);
  const t0 = Date.now();
  let ok = 0;

  // Prepare icons on first run
  if (!anilistIconBuf && !malIconBuf) await prepareIcons();

  // Clean old posters
  try { for (const f of fs.readdirSync(POSTERS_DIR)) fs.unlinkSync(path.join(POSTERS_DIR, f)); } catch {}

  // Generate anime posters
  for (const s of schedules) {
    const p = await generatePoster(s);
    if (p) { s.generatedPoster = p; ok++; }
  }

  // Generate separator posters
  const { getDayLabel } = require('./simkl');
  const days = [...new Set(schedules.map(s => s.dayOffset))].filter(d => d > 0).sort();
  for (const day of days) {
    const label = getDayLabel(day);
    await generateSeparator(day, label);
  }

  console.log(`🖼️ Generated ${ok}/${schedules.length} posters + ${days.length} separators (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

module.exports = { generateAllPosters, formatTimeCET };
