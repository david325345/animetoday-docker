const sharp = require('sharp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const POSTERS_DIR = path.join(__dirname, '..', 'public', 'posters');
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');
try { fs.mkdirSync(POSTERS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(ICONS_DIR, { recursive: true }); } catch {}

function formatTimeCET(unixTimestamp) {
  return new Date(unixTimestamp * 1000).toLocaleTimeString('cs-CZ', {
    timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// ===== Prepare icons (resize once at startup) =====
const ICON_SIZE = 34;
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

    // === Build badge data ===
    const badges = [];
    if (anilistScore && anilistIconBuf) badges.push({ iconBuf: anilistIconBuf, score: anilistScore });
    if (malScoreStr && malIconBuf) badges.push({ iconBuf: malIconBuf, score: malScoreStr });
    // Fallback: AniList score without icon
    if (!badges.length && anilistScore) badges.push({ iconBuf: null, score: `AL ${anilistScore}` });

    const badgeW = 130, badgeH = 42, gap = 14, radius = 10;
    const bottomBarH = badges.length ? 56 : 0;
    const totalBadgeW = badges.length * badgeW + (badges.length - 1) * gap;
    const badgeStartX = Math.round((W - totalBadgeW) / 2);
    const badgeY = H - bottomBarH + 7;

    // === SVG overlay: top bar + bottom bar background + score text ===
    const topBarSVG = `
      <rect x="0" y="0" width="${W}" height="${topBarH}" fill="rgba(0,0,0,0.80)"/>
      <text x="${W / 2}" y="29"
            font-family="DejaVu Sans,Noto Sans,sans-serif"
            font-size="24" font-weight="700"
            fill="white" text-anchor="middle">
        ${topLabel}
      </text>
    `;

    let bottomBarSVG = '';
    let badgeTextSVG = '';
    if (badges.length) {
      bottomBarSVG = `<rect x="0" y="${H - bottomBarH}" width="${W}" height="${bottomBarH}" fill="rgba(0,0,0,0.80)"/>`;
      badgeTextSVG = badges.map((b, i) => {
        const x = badgeStartX + i * (badgeW + gap);
        const textX = b.iconBuf ? x + ICON_SIZE + 12 : x + 10;
        return `
          <rect x="${x}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${radius}" fill="rgba(0,0,0,0.75)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
          <text x="${textX}" y="${badgeY + 29}" font-family="DejaVu Sans,Noto Sans,sans-serif" font-size="22" font-weight="700" fill="white">${b.score}</text>
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

    // Add icon images via sharp composite
    badges.forEach((b, i) => {
      if (b.iconBuf) {
        const x = badgeStartX + i * (badgeW + gap) + 5;
        const y = badgeY + Math.round((badgeH - ICON_SIZE) / 2);
        composites.push({ input: b.iconBuf, top: y, left: x });
      }
    });

    await sharp(Buffer.from(resp.data))
      .resize(W, H, { fit: 'cover' })
      .composite(composites)
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

  // Prepare icons on first run
  if (!anilistIconBuf && !malIconBuf) await prepareIcons();

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
