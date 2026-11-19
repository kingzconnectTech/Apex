/**
 * Shared constants and PURE view logic for the Admin Predictions system.
 *
 * Kept out of the screens so every decision the UI makes — how a prediction is
 * labelled, colour-coded, filtered, validated and formatted — can be unit tested
 * without a React Native renderer, and so the admin dashboard and the user-facing
 * Admin Picks screen agree on exactly one set of rules.
 *
 * CommonJS on purpose: no React Native imports, so it loads from plain Node
 * (`node --test frontend/__tests__`) as well as from Metro.
 *
 * This module is COMPLETELY separate from the AI prediction engine. It only
 * knows about the `admin_predictions` Firestore collection, which stores picks an
 * administrator uploaded by hand.
 */

/** The dedicated Firestore collection (nothing else is ever read/written here). */
const COLLECTION = 'admin_predictions';

const SPORTS = ['Football', 'Basketball', 'Tennis'];

/** The prediction statuses. Newly published picks are always `pending`. */
const STATUS = { PENDING: 'pending', WON: 'won', LOST: 'lost', VOID: 'void' };
const STATUSES = [STATUS.PENDING, STATUS.WON, STATUS.LOST, STATUS.VOID];

/** Draft picks are invisible to ordinary users; published picks are public. */
const VISIBILITY = { DRAFT: 'draft', PUBLISHED: 'published' };

/** Confidence is a percentage. */
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 100;

/** Field caps (mirror the sensibly-sized input hints in the forms). */
const LIMITS = {
  league: 80,
  team: 80,
  market: 60,
  selection: 120,
  analysis: 2000,
};

/**
 * Example markets per sport. These are examples the form offers, NOT a
 * restriction — the administrator can type any market.
 */
const MARKET_OPTIONS = {
  Football: [
    'Over/Under Goals',
    'Over/Under Corners',
    'Over/Under Cards',
    'Both Teams to Score',
    'Team Total Goals',
    'First Half Goals',
  ],
  Basketball: [
    'Over/Under Total Points',
    'Team Total Points',
    'Point Spread/Handicap',
  ],
  Tennis: [
    'Match Winner',
    'Set Winner',
    'Over/Under Total Games',
    'Over/Under Total Sets',
    'Handicap Games/Sets',
  ],
};

/** The user-facing filter chips, in order. */
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'football', label: 'Football' },
  { key: 'basketball', label: 'Basketball' },
  { key: 'tennis', label: 'Tennis' },
  { key: 'pending', label: 'Pending' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'void', label: 'Void' },
];

/** How each status is labelled, iconed and toned. `tone` maps to a theme colour. */
const STATUS_META = {
  [STATUS.PENDING]: { key: STATUS.PENDING, label: 'Pending', icon: 'time-outline', tone: 'accent' },
  [STATUS.WON]: { key: STATUS.WON, label: 'Won', icon: 'checkmark-circle', tone: 'success' },
  [STATUS.LOST]: { key: STATUS.LOST, label: 'Lost', icon: 'close-circle', tone: 'error' },
  [STATUS.VOID]: { key: STATUS.VOID, label: 'Void', icon: 'remove-circle', tone: 'muted' },
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ helpers */

/** Coerce a Firestore Timestamp / Date / number / string into a Date, or null. */
function toDate(value) {
  if (value == null) return null;
  if (typeof value.toDate === 'function') {
    try { return value.toDate(); } catch (err) { return null; }
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const pad2 = n => String(n).padStart(2, '0');

/** A stable `YYYY-MM-DD` key for a date value (local calendar day), or null. */
function dayKey(value) {
  const d = toDate(value);
  if (!d) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Format a match date/time for display with fixed English labels (deterministic
 * across environments — no reliance on the host locale).
 * @returns {{date:string, time:string, iso:string}|null}
 */
function formatMatchDateTime(value) {
  const d = toDate(value);
  if (!d) return null;
  return {
    date: `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    iso: d.toISOString(),
  };
}

/** Strip control characters and tags, collapse whitespace, and cap the length. */
function sanitizeText(value, maxLength = null) {
  let s = value == null ? '' : String(value);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (Number.isFinite(maxLength) && s.length > maxLength) s = s.slice(0, maxLength);
  return s;
}

function normalizeStatus(value) {
  const s = value == null ? '' : String(value).toLowerCase();
  return STATUSES.includes(s) ? s : STATUS.PENDING;
}

function statusMeta(value) {
  return STATUS_META[normalizeStatus(value)] || STATUS_META[STATUS.PENDING];
}

function statusLabel(value) {
  return statusMeta(value).label;
}

function statusToneColor(theme, value) {
  const tone = statusMeta(value).tone;
  switch (tone) {
    case 'success': return theme.success;
    case 'error': return theme.error;
    case 'accent': return theme.accent;
    default: return theme.textSecondary;
  }
}

/** "92%" from 92. Null-safe. */
function formatConfidence(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${Math.round(n)}%`;
}

/** A coarse confidence band for badge colour: 'high' | 'medium' | 'low' | null. */
function confidenceBand(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 80) return 'high';
  if (n >= 60) return 'medium';
  return 'low';
}

function isPublished(pick) {
  return Boolean(pick) && pick.visibility === VISIBILITY.PUBLISHED;
}

/* --------------------------------------------------------------- validation */

/**
 * Validate the upload / edit form.
 *
 * @param {Object} form { sport, league, homeTeam, awayTeam, matchDate, market, selection, confidence, analysis }
 * @returns {{valid:boolean, errors:Object, values:Object}}
 */
function validatePickForm(form) {
  const input = form || {};
  const errors = {};

  const sport = sanitizeText(input.sport, 20);
  const league = sanitizeText(input.league, LIMITS.league);
  const homeTeam = sanitizeText(input.homeTeam, LIMITS.team);
  const awayTeam = sanitizeText(input.awayTeam, LIMITS.team);
  const market = sanitizeText(input.market, LIMITS.market);
  const selection = sanitizeText(input.selection, LIMITS.selection);
  const analysis = sanitizeText(input.analysis, LIMITS.analysis);
  const matchDate = toDate(input.matchDate);

  if (!SPORTS.includes(sport)) errors.sport = 'Choose a sport.';
  if (!league) errors.league = 'League is required.';
  if (!homeTeam) errors.homeTeam = 'Home team is required.';
  if (!awayTeam) errors.awayTeam = 'Away team is required.';
  if (homeTeam && awayTeam && homeTeam.toLowerCase() === awayTeam.toLowerCase()) {
    errors.awayTeam = 'Home and away teams must be different.';
  }
  if (!matchDate) errors.matchDate = 'A valid match date and time is required.';
  if (!market) errors.market = 'Prediction market is required.';
  if (!selection) errors.selection = 'Prediction selection is required.';
  if (!analysis) errors.analysis = 'Prediction analysis is required.';

  const rawConfidence = input.confidence;
  const confidence = rawConfidence === '' || rawConfidence == null ? NaN : Number(rawConfidence);
  if (!Number.isFinite(confidence)) {
    errors.confidence = 'Confidence is required.';
  } else if (confidence < CONFIDENCE_MIN || confidence > CONFIDENCE_MAX) {
    errors.confidence = `Confidence must be between ${CONFIDENCE_MIN} and ${CONFIDENCE_MAX}.`;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    values: {
      sport,
      league,
      homeTeam,
      awayTeam,
      matchDate,
      market,
      selection,
      confidence: Number.isFinite(confidence) ? confidence : null,
      analysis,
    },
  };
}

/* ------------------------------------------------------- duplicates & search */

/**
 * The identity of a pick for duplicate detection: same sport, same teams, same
 * kick-off, same market and selection. A re-submission of the same pick (a stray
 * double tap, or a re-upload) collides on this key.
 */
function duplicateKey(pick) {
  const p = pick || {};
  return [
    sanitizeText(p.sport, 20).toLowerCase(),
    sanitizeText(p.homeTeam, LIMITS.team).toLowerCase(),
    sanitizeText(p.awayTeam, LIMITS.team).toLowerCase(),
    dayKey(p.matchDate) || '',
    sanitizeText(p.market, LIMITS.market).toLowerCase(),
    sanitizeText(p.selection, LIMITS.selection).toLowerCase(),
  ].join('|');
}

/**
 * True when `form` matches an existing pick. `excludeId` lets an edit ignore the
 * record being edited.
 */
function isDuplicatePick(form, picks, { excludeId = null } = {}) {
  const key = duplicateKey(form);
  const list = Array.isArray(picks) ? picks : [];
  return list.some(p => {
    if (!p) return false;
    if (excludeId != null && (p.id === excludeId || p.docId === excludeId)) return false;
    return duplicateKey(p) === key;
  });
}

/** Case-insensitive substring match on either team name. */
function pickMatchesSearch(pick, query) {
  const q = sanitizeText(query).toLowerCase();
  if (!q) return true;
  const home = sanitizeText(pick && pick.homeTeam).toLowerCase();
  const away = sanitizeText(pick && pick.awayTeam).toLowerCase();
  return home.includes(q) || away.includes(q);
}

/** The user-facing filter chip predicate. */
function applyUserFilter(picks, filterKey) {
  const list = Array.isArray(picks) ? picks : [];
  const key = (filterKey || 'all').toLowerCase();
  if (key === 'all') return list.slice();
  if (key === 'football') return list.filter(p => p && p.sport === 'Football');
  if (key === 'basketball') return list.filter(p => p && p.sport === 'Basketball');
  if (key === 'tennis') return list.filter(p => p && p.sport === 'Tennis');
  if (STATUSES.includes(key)) return list.filter(p => p && normalizeStatus(p.status) === key);
  return list.slice();
}

/** The management-screen filters (sport, league, status, calendar day). */
function applyManageFilters(picks, { sport = 'All', league = 'All', status = 'All', date = null } = {}) {
  const list = Array.isArray(picks) ? picks : [];
  const day = date ? dayKey(date) : null;
  return list.filter(p => {
    if (!p) return false;
    if (sport && sport !== 'All' && p.sport !== sport) return false;
    if (league && league !== 'All' && p.league !== league) return false;
    if (status && status !== 'All' && normalizeStatus(p.status) !== status) return false;
    if (day && dayKey(p.matchDate) !== day) return false;
    return true;
  });
}

/** Distinct league names present on the given picks (for the league filter). */
function leagueOptions(picks) {
  const set = new Set();
  (Array.isArray(picks) ? picks : []).forEach(p => { if (p && p.league) set.add(p.league); });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/* --------------------------------------------------------------- summaries */

/** Dashboard counts. */
function summarizePicks(picks) {
  const list = Array.isArray(picks) ? picks : [];
  const summary = { total: list.length, pending: 0, won: 0, lost: 0, void: 0, published: 0, draft: 0 };
  list.forEach(p => {
    if (!p) return;
    const s = normalizeStatus(p.status);
    summary[s] += 1;
    if (p.visibility === VISIBILITY.DRAFT) summary.draft += 1;
    else summary.published += 1;
  });
  return summary;
}

/** Newest kick-off first; picks without a date sort last. */
function sortPicks(picks) {
  const list = Array.isArray(picks) ? picks : [];
  return list.slice().sort((a, b) => {
    const da = toDate(a && a.matchDate);
    const db = toDate(b && b.matchDate);
    if (da && db) return db.getTime() - da.getTime();
    if (da) return -1;
    if (db) return 1;
    return 0;
  });
}

/**
 * The exact Firestore payload for a CREATE. The service adds the server fields
 * (`createdBy`, `createdAt`, `updatedAt`) and converts `matchDate` to a
 * Firestore Timestamp.
 */
function buildCreatePayload(form, { visibility = VISIBILITY.DRAFT } = {}) {
  const { valid, values, errors } = validatePickForm(form);
  if (!valid) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      sport: values.sport,
      league: values.league,
      homeTeam: values.homeTeam,
      awayTeam: values.awayTeam,
      matchDate: values.matchDate,
      market: values.market,
      selection: values.selection,
      confidence: values.confidence,
      analysis: values.analysis,
      status: STATUS.PENDING,
      visibility,
    },
  };
}

/**
 * The subset of a pick that an EDIT may change. Status/settlement and ownership
 * are intentionally excluded — those flow through the dedicated settle methods.
 */
function buildUpdatePayload(form) {
  const { valid, values, errors } = validatePickForm(form);
  if (!valid) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      sport: values.sport,
      league: values.league,
      homeTeam: values.homeTeam,
      awayTeam: values.awayTeam,
      matchDate: values.matchDate,
      market: values.market,
      selection: values.selection,
      confidence: values.confidence,
      analysis: values.analysis,
    },
  };
}

/** Turn a stored pick document into the form shape the upload/edit screen edits. */
function pickToForm(pick) {
  const p = pick || {};
  return {
    sport: p.sport || SPORTS[0],
    league: p.league || '',
    homeTeam: p.homeTeam || '',
    awayTeam: p.awayTeam || '',
    matchDate: toDate(p.matchDate),
    market: p.market || '',
    selection: p.selection || '',
    confidence: p.confidence == null ? '' : String(p.confidence),
    analysis: p.analysis || '',
  };
}

module.exports = {
  COLLECTION,
  SPORTS,
  STATUS,
  STATUSES,
  STATUS_META,
  VISIBILITY,
  CONFIDENCE_MIN,
  CONFIDENCE_MAX,
  LIMITS,
  MARKET_OPTIONS,
  FILTERS,
  toDate,
  dayKey,
  formatMatchDateTime,
  sanitizeText,
  normalizeStatus,
  statusMeta,
  statusLabel,
  statusToneColor,
  formatConfidence,
  confidenceBand,
  isPublished,
  validatePickForm,
  duplicateKey,
  isDuplicatePick,
  pickMatchesSearch,
  applyUserFilter,
  applyManageFilters,
  leagueOptions,
  summarizePicks,
  sortPicks,
  buildCreatePayload,
  buildUpdatePayload,
  pickToForm,
};
