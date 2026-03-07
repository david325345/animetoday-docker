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

async function generatePoster(schedule) {
  const m = schedule.media;
  const posterUrl = schedule.tmdbImages?.poster || m.coverImage?.extraLarge || m.coverImage?.large;
  if (!posterUrl || posterUrl === 'null') return null;

  const outputPath = path.join(POSTERS_DIR, `${m.id}.jpg`);
  const timeStr = formatTimeCET(schedule.airingAt);
  const score = m.averageScore ? (m.averageScore / 10).toFixed(1) : null;
  const label = score ? `${timeStr} | ${score}/10` : timeStr;

  try {
    const resp = await axios.get(posterUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const W = 500, H = 750, barH = 70, fontSize = 34;

    const svgOverlay = `
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="${H - barH}" width="${W}" height="${barH}" fill="rgba(0,0,0,0.85)"/>
        <text x="${W / 2}" y="${H - 18}"
              font-family="DejaVu Sans,Noto Sans,sans-serif"
              font-size="${fontSize}" font-weight="700"
              fill="white" text-anchor="middle">
          ${label}
        </text>
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

async function generateAllPosters(schedules) {
  console.log(`🖼️ Generating ${schedules.length} posters...`);
  const t0 = Date.now();
  let ok = 0;

  // Clean old
  try { for (const f of fs.readdirSync(POSTERS_DIR)) fs.unlinkSync(path.join(POSTERS_DIR, f)); } catch {}

  for (const s of schedules) {
    const p = await generatePoster(s);
    if (p) { s.generatedPoster = p; ok++; }
  }
  console.log(`🖼️ Generated ${ok}/${schedules.length} posters (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

module.exports = { generateAllPosters, formatTimeCET };
