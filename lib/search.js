// ===== Sort & resolution/group detection helpers =====
// Stripped down from the full search lib — torrent search logic moved entirely
// to the indexer service. This module now provides:
//   - sortByGroupPriority(): preset sort + per-filter toggles (groups/res/lang/excludeRes)
//   - detectResolution() / detectGroup() / detectQuality(): name parsing fallbacks
//   - DEFAULT_GROUPS / DEFAULT_RESOLUTIONS: defaults for sort prefs UI

const DEFAULT_GROUPS = [
  'SubsPlease', 'Erai-raws', 'EMBER', 'ASW', 'Judas',
  'AnimeRG', 'Anime Time', 'Mysteria', 'Yameii', 'ToonsHub',
  'VARYG', 'Golumpa', 'New-raws', 'DeadFish', 'Hi10', 'Coalgirls'
];
const DEFAULT_RESOLUTIONS = ['SeaDex', '4K', '1080p', '720p', '480p', 'DVD'];

// ===== Canonical resolution tier =====
// Maps any resolution-ish string ("4K", "2160p", "UHD", "1080p", "FHD", …) to a
// single canonical tier key so user exclusion lists match release labels
// regardless of which synonym either side uses. The UI offers ONE label per
// tier ("4K", "1080p", …) but indexer-provided `t.resolution` and release
// titles in the wild use any of the synonyms. Unknown values fall through as
// lowercase raw — so unfamiliar labels still match themselves.
function canonicalResTier(raw) {
  if (!raw) return '';
  const s = String(raw).toLowerCase().trim();
  if (s === 'seadex') return 'seadex';
  if (s === '4k' || s === '2160p' || s === '2160' || s === 'uhd' || s === '4kuhd' || s === '4k-uhd') return '4k';
  if (s === '1080p' || s === '1080' || s === 'fhd') return '1080p';
  if (s === '720p' || s === '720' || s === 'hd') return '720p';
  if (s === '480p' || s === '480' || s === 'sd') return '480p';
  if (s === 'dvd' || s === 'dvdrip') return 'dvd';
  return s;
}

function detectQuality(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('2160p') || n.includes('4k')) return '4K';
  if (n.includes('1080p')) return '1080p';
  if (n.includes('720p')) return '720p';
  if (n.includes('480p')) return '480p';
  return '';
}

function detectGroup(name) {
  for (const g of DEFAULT_GROUPS) {
    if ((name || '').includes(g)) return g;
  }
  return '';
}

function detectResolution(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return '4K';
  if (n.includes('1080p')) return '1080p';
  if (n.includes('720p')) return '720p';
  if (n.includes('480p')) return '480p';
  if (n.includes('dvd') || n.includes('dvdrip')) return 'DVD';
  return '';
}

function sortByGroupPriority(torrents, userPrefs = null) {
  let withMagnet = torrents.filter(t => t.magnet);

  // Sort mode (4 presets only — no custom)
  let mode = userPrefs?.sortMode;
  if (!mode || mode === 'custom') mode = 'qualityThenSeeders';

  // Per-filter toggles (each can be ON/OFF independently)
  const groupsEnabled = !!userPrefs?.groupsEnabled;
  const resEnabled = !!userPrefs?.resEnabled;
  const excludeResEnabled = !!userPrefs?.excludeResEnabled;
  const langsEnabled = !!userPrefs?.langsEnabled;

  const groupOrder = userPrefs?.groupPriority || DEFAULT_GROUPS;
  const resOrder = userPrefs?.resPriority || DEFAULT_RESOLUTIONS;
  const langOrder = userPrefs?.langPriority || [];
  // Normalize the user's exclusion list to canonical tiers so "4K" excludes
  // releases that report `t.resolution = '2160p'` (or 'UHD', etc.) too.
  const excludedRes = new Set(
    (userPrefs?.excludedResolutions || [])
      .map(r => canonicalResTier(r))
      .filter(Boolean)
  );

  // Pre-filter: exclude resolutions if toggle ON (never exclude SeaDex)
  if (excludeResEnabled && excludedRes.size) {
    withMagnet = withMagnet.filter(t => {
      if (t.seadex) return true;
      // Prefer indexer-provided resolution metadata, fallback to name detection.
      // detectResolution() already canonicalizes ('2160p' -> '4K'), but
      // `t.resolution` from the indexer can be anything — so normalize before
      // comparing.
      const raw = t.resolution || detectResolution(t.name) || '';
      const tier = canonicalResTier(raw);
      if (tier && excludedRes.has(tier)) return false;
      return true;
    });
  }

  // Helpers
  // Resolution rank uses canonical tiers on BOTH sides (user prefs and the
  // release's resolution) so a release labeled "2160p"/"UHD" ranks identically
  // to one labeled "4K". Without this, releases with non-canonical labels would
  // fall to the worst bucket (indexOf miss).
  const tierOrder = [...resOrder, ...DEFAULT_RESOLUTIONS]
    .map(r => canonicalResTier(r))
    .filter((v, i, a) => v && a.indexOf(v) === i); // dedupe
  const tierOrderDefault = DEFAULT_RESOLUTIONS
    .map(r => canonicalResTier(r))
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const releaseResTier = (t) => {
    if (t.seadex) return 'seadex';
    const raw = t.resolution || detectResolution(t.name) || '';
    return canonicalResTier(raw);
  };

  const getResRank = (t) => {
    const tier = releaseResTier(t);
    if (!tier) return resOrder.length;
    const idx = tierOrder.indexOf(tier);
    return idx >= 0 ? idx : resOrder.length;
  };
  const getResRankDefault = (t) => {
    const tier = releaseResTier(t);
    if (!tier) return DEFAULT_RESOLUTIONS.length;
    const idx = tierOrderDefault.indexOf(tier);
    return idx >= 0 ? idx : DEFAULT_RESOLUTIONS.length;
  };
  const getGroupRank = (t) => {
    const grp = detectGroup(t.name);
    if (!grp) return groupOrder.length;
    const idx = groupOrder.indexOf(grp);
    return idx >= 0 ? idx : groupOrder.length;
  };
  const getLangRank = (t) => {
    if (!langOrder.length) return 0;
    const langs = String(t.audioLangs || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!langs.length) return langOrder.length;
    let best = langOrder.length;
    for (const l of langs) {
      const idx = langOrder.findIndex(x => x.toLowerCase() === l);
      if (idx >= 0 && idx < best) best = idx;
    }
    return best;
  };
  const getSeeders = (t) => parseInt(t.seeders) || 0;
  const getSize = (t) => {
    if (t.matchedFile?.size) return t.matchedFile.size;
    if (t.filesizeBytes) return t.filesizeBytes;
    return parseInt(t.filesize) || 0;
  };

  // Primary sort comparator (per preset mode)
  const primaryCmp = (a, b) => {
    if (mode === 'qualityThenSeeders') {
      const r = getResRankDefault(a) - getResRankDefault(b);
      if (r !== 0) return r;
      return getSeeders(b) - getSeeders(a);
    }
    if (mode === 'qualityThenSize') {
      const r = getResRankDefault(a) - getResRankDefault(b);
      if (r !== 0) return r;
      return getSize(b) - getSize(a);
    }
    if (mode === 'seeders') return getSeeders(b) - getSeeders(a);
    if (mode === 'size') return getSize(b) - getSize(a);
    return 0;
  };

  // Tie-breaker comparators (only applied where toggle is ON)
  const tieBreakers = [];
  if (resEnabled) tieBreakers.push((a, b) => getResRank(a) - getResRank(b));
  if (groupsEnabled) tieBreakers.push((a, b) => getGroupRank(a) - getGroupRank(b));
  if (langsEnabled) tieBreakers.push((a, b) => getLangRank(a) - getLangRank(b));

  return [...withMagnet].sort((a, b) => {
    const p = primaryCmp(a, b);
    if (p !== 0) return p;
    for (const cmp of tieBreakers) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return 0;
  });
}

module.exports = {
  detectQuality,
  detectResolution,
  detectGroup,
  canonicalResTier,
  sortByGroupPriority,
  DEFAULT_GROUPS,
  DEFAULT_RESOLUTIONS,
};
