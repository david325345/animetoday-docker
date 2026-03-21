const sharp = require('sharp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const POSTERS_DIR = path.join(__dirname, '..', 'public', 'posters');
try { fs.mkdirSync(POSTERS_DIR, { recursive: true }); } catch {}

function formatTimeCET(unixTimestamp) {
  return new Date(unixTimestamp * 1000).toLocaleTimeString('cs-CZ', {
    timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// ===== MAL score fetcher via Jikan API =====
const malScoreCache = new Map();

async function fetchMALScore(malId) {
  if (!malId) return null;
  if (malScoreCache.has(malId)) return malScoreCache.get(malId);
  try {
    const resp = await axios.get(`https://api.jikan.moe/v4/anime/${malId}`, { timeout: 8000 });
    const score = resp.data?.data?.score || null;
    malScoreCache.set(malId, score);
    return score;
  } catch {
    malScoreCache.set(malId, null);
    return null;
  }
}

// ===== SVG icons as inline paths =====
// AniList icon — simplified "AL" in circle
const ANILIST_ICON = `
  <g transform="translate(0,0)">
    <rect width="26" height="26" rx="5" fill="#02A9FF"/>
    <text x="13" y="19" font-family="DejaVu Sans,sans-serif" font-size="15" font-weight="700" fill="white" text-anchor="middle">AL</text>
  </g>
`;

// MAL icon — "MAL" in blue rounded rect
const MAL_ICON = `
  <g transform="translate(0,0)">
    <rect width="26" height="26" rx="5" fill="#2E51A2"/>
    <text x="13" y="18" font-family="DejaVu Sans,sans-serif" font-size="11" font-weight="700" fill="white" text-anchor="middle">MAL</text>
  </g>
`;

function buildBadgeSVG(iconSVG, scoreText, xOffset) {
  const badgeW = 105, badgeH = 32, radius = 8;
  return `
    <g transform="translate(${xOffset}, 0)">
      <rect width="${badgeW}" height="${badgeH}" rx="${radius}" fill="rgba(0,0,0,0.75)"/>
      <g transform="translate(4, 3)">${iconSVG}</g>
      <text x="36" y="22" font-family="DejaVu Sans,Noto Sans,sans-serif" font-size="18" font-weight="700" fill="white">${scoreText}</text>
    </g>
  `;
}

async function generatePoster(schedule, malScore) {
  const m = schedule.media;
  const posterUrl = schedule.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large;
  if (!posterUrl || posterUrl === 'null') return null;

  const outputPath = path.join(POSTERS_DIR, `${m.id}.jpg`);
  const timeStr = formatTimeCET(schedule.airingAt);
  const anilistScore = m.averageScore ? (m.averageScore / 10).toFixed(1) : null;
  const malScoreStr = malScore ? malScore.toFixed(1) : null;

  try {
    const resp = await axios.get(posterUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const W = 500, H = 750;

    // === TOP BAR: airing time + episode ===
    const topBarH = 42;
    const topLabel = `${timeStr} · Ep ${schedule.episode}`;
    const topBarSVG = `
      <rect x="0" y="0" width="${W}" height="${topBarH}" fill="rgba(0,0,0,0.80)"/>
      <text x="${W / 2}" y="29"
            font-family="DejaVu Sans,Noto Sans,sans-serif"
            font-size="24" font-weight="700"
            fill="white" text-anchor="middle">
        ${topLabel}
      </text>
    `;

    // === BOTTOM: rating badges ===
    const badges = [];
    if (anilistScore) badges.push({ icon: ANILIST_ICON, score: anilistScore });
    if (malScoreStr) badges.push({ icon: MAL_ICON, score: malScoreStr });

    let bottomSVG = '';
    if (badges.length > 0) {
      const badgeW = 105, gap = 12;
      const totalW = badges.length * badgeW + (badges.length - 1) * gap;
      const startX = (W - totalW) / 2;
      const bottomBarH = 46;
      const badgeY = H - bottomBarH + 7;

      bottomSVG = `
        <rect x="0" y="${H - bottomBarH}" width="${W}" height="${bottomBarH}" fill="rgba(0,0,0,0.80)"/>
        <g transform="translate(${startX}, ${badgeY})">
          ${badges.map((b, i) => buildBadgeSVG(b.icon, b.score, i * (badgeW + gap))).join('')}
        </g>
      `;
    }

    const svgOverlay = `
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${topBarSVG}
        ${bottomSVG}
      </svg>
    `;

    await sharp(Buffer.from(resp.data))
      .resize(W, H, { fit: 'cover' })
      .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    return `/posters/${m.id}.jpg`;
  } catch (err) {
    console.error(`  🖼️ Poster error ${m.id}: ${err.message}`);
    return null;
  }
}

async function generateAllPosters(schedules, offlineDB) {
  console.log(`🖼️ Generating ${schedules.length} posters...`);
  const t0 = Date.now();
  let ok = 0;

  // Clean old
  try { for (const f of fs.readdirSync(POSTERS_DIR)) fs.unlinkSync(path.join(POSTERS_DIR, f)); } catch {}

  // Fetch MAL scores (with rate limit — Jikan allows ~3 req/s)
  const malScores = new Map();
  if (offlineDB?.byAniList) {
    for (const s of schedules) {
      const offRec = offlineDB.byAniList.get(s.media.id);
      if (offRec?.mal) {
        const score = await fetchMALScore(offRec.mal);
        if (score) malScores.set(s.media.id, score);
        // Jikan rate limit: ~3 req/s, wait 350ms between requests
        await new Promise(r => setTimeout(r, 350));
      }
    }
    if (malScores.size) console.log(`🖼️ MAL scores: ${malScores.size}/${schedules.length}`);
  }

  for (const s of schedules) {
    const malScore = malScores.get(s.media.id) || null;
    const p = await generatePoster(s, malScore);
    if (p) { s.generatedPoster = p; ok++; }
  }
  console.log(`🖼️ Generated ${ok}/${schedules.length} posters (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

module.exports = { generateAllPosters, formatTimeCET };
