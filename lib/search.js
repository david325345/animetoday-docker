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
  const excludedRes = new Set((userPrefs?.excludedResolutions || []).map(r => r.toLowerCase()));

  // Pre-filter: exclude resolutions if toggle ON (never exclude SeaDex)
  if (excludeResEnabled && excludedRes.size) {
    withMagnet = withMagnet.filter(t => {
      if (t.seadex) return true;
      // Prefer indexer-provided resolution metadata, fallback to name detection
      const res = (t.resolution || detectResolution(t.name) || '').toLowerCase();
      if (res && excludedRes.has(res)) return false;
      return true;
    });
  }

  // Helpers
  const getResRank = (t) => {
    const res = t.seadex ? 'SeaDex' : (t.resolution || detectResolution(t.name) || '');
    if (!res) return resOrder.length;
    const idx = resOrder.indexOf(res);
    return idx >= 0 ? idx : resOrder.length;
  };
  const getResRankDefault = (t) => {
    const res = t.seadex ? 'SeaDex' : (t.resolution || detectResolution(t.name) || '');
    if (!res) return DEFAULT_RESOLUTIONS.length;
    const idx = DEFAULT_RESOLUTIONS.indexOf(res);
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
  sortByGroupPriority,
  DEFAULT_GROUPS,
  DEFAULT_RESOLUTIONS,
};
