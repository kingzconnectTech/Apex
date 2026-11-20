/**
 * Pure view logic for Live Game Analysis.
 *
 * Kept out of the screen so every decision the UI makes — which state to show,
 * whether to render a probability, how to label the clock — can be unit tested
 * without a React Native renderer.
 *
 * CommonJS on purpose: no React Native imports, so it loads from plain Node
 * (`node --test frontend/__tests__`) as well as from Metro.
 *
 * The one rule that matters: when the backend's ship gate refuses
 * (`display.shows_probabilities === false`), the probability and projection
 * rows are EMPTY. The UI renders the score, the clock and the facts, and says
 * why the numbers are missing — it never shows a 0%, and never a placeholder.
 */

/** The states the live-analysis screen can be in. */
const VIEW_STATE = {
  IDLE: 'idle',
  LOADING: 'loading',
  ANALYSIS: 'analysis',
  CANDIDATES: 'candidates',
  NONE: 'none',
  ERROR: 'error',
};

const MESSAGES = {
  network: 'Network error. Check your connection.',
  rateLimited: 'Too many requests right now. Please wait a moment and try again.',
  featureDisabled: 'Live game analysis is switched off.',
  manualDisabled: 'Manual entry is switched off.',
  invalidLink: 'That does not look like a link. Paste the full bookmaker URL.',
  notResolved: 'This game is no longer being tracked. Paste the link again.',
  notConfigured: 'Live game analysis is unavailable on this server.',
  invalidManual: 'Some of those values could not be used.',
  generic: 'Live game analysis could not be completed right now.',
  noMatch: 'We could not find that game. Enter the details below instead.',
};

/**
 * The badge a hand-typed game always carries. It comes from the backend payload
 * so there is exactly one wording; this is only the fallback if it is missing.
 */
const MANUAL_BADGE = 'User-entered, unverified';

const UNKNOWN_TEAM = 'the home side';

/**
 * Turn a failed live response into a specific, honest message.
 * @param {Object|null} result { unavailable, httpStatus, code, message, errors }
 * @returns {string}
 */
function describeLiveFailure(result) {
  switch (result && result.code) {
    case 'NETWORK_ERROR': return MESSAGES.network;
    case 'RATE_LIMITED': return MESSAGES.rateLimited;
    case 'FEATURE_DISABLED': return MESSAGES.featureDisabled;
    case 'MANUAL_ENTRY_DISABLED': return MESSAGES.manualDisabled;
    case 'INVALID_LINK': return MESSAGES.invalidLink;
    case 'GAME_NOT_RESOLVED': return MESSAGES.notResolved;
    case 'NOT_CONFIGURED': return MESSAGES.notConfigured;
    case 'INVALID_MANUAL_ENTRY':
      return Array.isArray(result.errors) && result.errors.length
        ? result.errors.join(' ')
        : MESSAGES.invalidManual;
    default: return (result && result.message) || MESSAGES.generic;
  }
}

/**
 * Classify a resolve response.
 * @param {Object|null} result
 * @returns {{state:string, message:string|null, analysis:Object|null, game:Object|null, candidates:Array, manualEntry:boolean, reason:string|null}}
 */
function classifyResolveResult(result) {
  const base = {
    state: VIEW_STATE.LOADING,
    message: null,
    analysis: null,
    game: null,
    candidates: [],
    manualEntry: false,
    reason: null,
  };
  if (result == null) return base;
  if (result.unavailable) {
    return { ...base, state: VIEW_STATE.ERROR, message: describeLiveFailure(result) };
  }

  if (result.status === 'matched') {
    return {
      ...base,
      state: VIEW_STATE.ANALYSIS,
      analysis: result.analysis || null,
      game: result.game || null,
    };
  }
  if (result.status === 'candidates') {
    return {
      ...base,
      state: VIEW_STATE.CANDIDATES,
      candidates: Array.isArray(result.candidates) ? result.candidates : [],
      message: result.reason || null,
    };
  }
  if (result.status === 'none') {
    return {
      ...base,
      state: VIEW_STATE.NONE,
      message: result.reason || MESSAGES.noMatch,
      manualEntry: Boolean(result.manual_entry_required),
    };
  }
  return { ...base, state: VIEW_STATE.ERROR, message: MESSAGES.generic };
}

/** Classify an analysis (poll) response. */
function classifyAnalysisResult(result) {
  if (result == null) return { state: VIEW_STATE.LOADING, message: null, analysis: null };
  if (result.unavailable) {
    return { state: VIEW_STATE.ERROR, message: describeLiveFailure(result), analysis: null };
  }
  if (result.display && result.game_id) {
    return { state: VIEW_STATE.ANALYSIS, message: null, analysis: result };
  }
  return { state: VIEW_STATE.ERROR, message: MESSAGES.generic, analysis: null };
}

/* ------------------------------------------------------------------ helpers */

function formatPercent(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  return `${(p * 100).toFixed(1)}%`;
}

function teamNames(analysis) {
  return {
    home: (analysis && analysis.home && analysis.home.name) || UNKNOWN_TEAM,
    away: (analysis && analysis.away && analysis.away.name) || 'the away side',
  };
}

/** `"1 - 0"`, or `"- - -"` when a score is genuinely missing. */
function scoreLine(analysis) {
  const home = analysis && analysis.home ? analysis.home.score : null;
  const away = analysis && analysis.away ? analysis.away.score : null;
  const fmt = v => (v == null ? '-' : String(v));
  return `${fmt(home)} - ${fmt(away)}`;
}

/**
 * The period label for a clock string: a QUARTER for basketball (Q1..Q4, then
 * OT) and a plain period otherwise (P1, P2). Null when the source gave no
 * period, so the clock renders alone rather than inventing one.
 */
function periodLabel(sport, period) {
  const n = Number(period);
  if (!(n >= 1)) return null;
  if (sport === 'basketball') return n > 4 ? 'OT' : `Q${n}`;
  return `P${n}`;
}

/** Human clock label: state first, then clock and period. */
function clockLine(analysis) {
  const live = (analysis && analysis.live) || {};
  const sport = analysis && analysis.sport;
  if (live.status === 'finished') return 'Finished';
  if (live.status === 'scheduled') return 'Not started';
  if (live.clock) {
    const p = periodLabel(sport, live.period);
    return p ? `${live.clock} · ${p}` : String(live.clock);
  }
  // A source that publishes no clock (FlashScore's list feed, or LiveScore
  // basketball's quarter-only feed) still gets one DERIVED from kick-off by the
  // server. It is labelled "(est.)" so it is never mistaken for a source-
  // reported time.
  const derived = live.derived_clock;
  if (derived && derived.clock) {
    const p = periodLabel(sport, derived.period);
    const core = p ? `${derived.clock} · ${p}` : String(derived.clock);
    return `${core} (est.)`;
  }
  return 'Clock unavailable';
}

/** True only when the backend says a model figure may be shown. */
function showsProbabilities(analysis) {
  return Boolean(analysis && analysis.display && analysis.display.shows_probabilities === true);
}

/**
 * The permanent badge for a hand-typed game, or null for a provider game. It is
 * NEVER conditional on the ship gate or on which figures render.
 */
function manualBadge(analysis) {
  if (!analysis || analysis.manual !== true) return null;
  return analysis.manual_badge || MANUAL_BADGE;
}

/** The longer explanation that accompanies the badge, or null. */
function manualBadgeDetail(analysis) {
  if (!analysis || analysis.manual !== true) return null;
  return analysis.manual_badge_detail || null;
}

/**
 * Plain text for any share or export of an analysis. A hand-typed game's badge
 * is prepended, so a shared/exported string can never present unverified values
 * as if they had been checked.
 */
function shareText(analysis) {
  if (!analysis) return '';
  const { home, away } = teamNames(analysis);
  const parts = [`${home} ${scoreLine(analysis)} ${away}`, clockLine(analysis)];
  const badge = manualBadge(analysis);
  return (badge ? `[${badge}] ${parts.join(' · ')}` : parts.join(' · ')).trim();
}

/** The reason the gate withheld the figures, or null when it did not. */
function withheldNotice(analysis) {
  if (!analysis) return null;
  if (showsProbabilities(analysis)) return null;
  const gate = analysis.ship_gate || {};
  return gate.reason || analysis.probabilities_note || 'No validated live probability is available for this game yet.';
}

/**
 * Probability rows, in the order a reader expects. Empty when the gate refuses
 * — the caller renders nothing rather than a zero.
 */
function probabilityRows(analysis) {
  if (!showsProbabilities(analysis)) return [];
  const p = analysis.probabilities;
  if (!p) return [];
  const { home, away } = teamNames(analysis);
  const rows = [];
  if (p.home_win != null) rows.push({ key: 'home_win', label: `${home} win`, value: p.home_win, display: formatPercent(p.home_win) });
  if (p.draw != null) rows.push({ key: 'draw', label: 'Draw', value: p.draw, display: formatPercent(p.draw) });
  if (p.away_win != null) rows.push({ key: 'away_win', label: `${away} win`, value: p.away_win, display: formatPercent(p.away_win) });
  return rows;
}

/** The display label for a match-result selection, or null if unrecognised. */
function resultLabel(selection, home, away) {
  if (selection === 'home') return `${home} win`;
  if (selection === 'away') return `${away} win`;
  if (selection === 'draw') return 'Draw';
  return null;
}

/**
 * The recommended picks (match result + Over/Under) as renderable rows, each
 * carrying the model's probability as its confidence. Empty when the gate
 * withholds the figures, or when a market could not be priced — the caller
 * renders nothing rather than a placeholder.
 */
function pickRows(analysis) {
  const picks = analysis && analysis.picks;
  if (!showsProbabilities(analysis) || !picks) return [];
  const { home, away } = teamNames(analysis);
  const rows = [];

  const mr = picks.match_result;
  if (mr && mr.selection) {
    if (mr.market === 'double_chance') {
      const dcLabel = { '1x': '1X (Home or Draw)', x2: 'X2 (Away or Draw)', '12': '12 (Home or Away)' }[mr.selection] || mr.selection.toUpperCase();
      rows.push({
        key: 'match_result',
        market: 'Double chance',
        label: dcLabel,
        display: formatPercent(mr.probability),
      });
    } else {
      rows.push({
        key: 'match_result',
        market: mr.market === '1x2' ? 'Match result' : 'Winner',
        label: resultLabel(mr.selection, home, away),
        display: formatPercent(mr.probability),
      });
    }
  }

  const ou = picks.over_under;
  if (ou && ou.selection && ou.line != null) {
    rows.push({
      key: 'over_under',
      market: 'Total',
      label: `${ou.selection === 'over' ? 'Over' : 'Under'} ${ou.line}`,
      display: formatPercent(ou.probability),
    });
  }

  // Soccer-only rate markets, priced from the live-stat feeds. Absent (null)
  // whenever the provider gave no count, so no placeholder is ever rendered.
  for (const [key, label] of [['corners', 'Corners'], ['shots', 'Shots']]) {
    const p = picks[key];
    if (p && p.selection && p.line != null) {
      rows.push({
        key,
        market: label,
        label: `${p.selection === 'over' ? 'Over' : 'Under'} ${p.line}`,
        display: formatPercent(p.probability),
      });
    }
  }

  return rows;
}

/** Projection rows. Empty when the gate refuses. */
function projectionRows(analysis) {
  const pr = analysis && analysis.projection;
  if (!showsProbabilities(analysis) || !pr) return [];
  const rows = [];
  if (pr.expected_final) {
    rows.push({ label: 'Projected final', display: `${pr.expected_final.home} - ${pr.expected_final.away}` });
    if (pr.expected_final.total != null) rows.push({ label: 'Projected total', display: String(pr.expected_final.total) });
    if (pr.expected_final.margin != null) rows.push({ label: 'Projected margin', display: String(pr.expected_final.margin) });
  }
  if (pr.total_line) rows.push({ label: 'Total line', display: `${pr.total_line.line} ± ${pr.total_line.sigma}` });
  if (pr.margin_line) rows.push({ label: 'Margin line', display: `${pr.margin_line.line} ± ${pr.margin_line.sigma}` });
  if (pr.remaining) rows.push({ label: 'Still to come', display: `${pr.remaining.home} - ${pr.remaining.away}` });
  if (pr.next_goal) {
    rows.push({
      label: 'Next goal',
      display: `home ${formatPercent(pr.next_goal.home)} · away ${formatPercent(pr.next_goal.away)} · none ${formatPercent(pr.next_goal.none)}`,
    });
  }
  return rows;
}

/* --------------------------------------------------------- live statistics */

/** Fields worth a comparison row, in display order (football). */
const STAT_ROWS = [
  ['possession_pct', 'Possession', '%'],
  ['shots', 'Shots', ''],
  ['shots_on_target', 'Shots on target', ''],
  ['shots_off_target', 'Shots off target', ''],
  ['corners', 'Corners', ''],
  ['passes', 'Passes', ''],
  ['tackles', 'Tackles', ''],
  ['interceptions', 'Interceptions', ''],
  ['saves', 'Saves', ''],
  ['yellow_cards', 'Yellow cards', ''],
  ['red_cards', 'Red cards', ''],
  ['fouls', 'Fouls', ''],
];

/** Basketball comparison rows — the boxscore fields the live model also reads. */
const STAT_ROWS_BASKETBALL = [
  ['trb', 'Rebounds', ''],
  ['orb', 'Off. rebounds', ''],
  ['drb', 'Def. rebounds', ''],
  ['ast', 'Assists', ''],
  ['tov', 'Turnovers', ''],
  ['stl', 'Steals', ''],
  ['blk', 'Blocks', ''],
  ['pf', 'Fouls', ''],
  ['fgm', 'Field goals made', ''],
  ['fga', 'Field goal attempts', ''],
  ['tpm', 'Three-pointers made', ''],
  ['ftm', 'Free throws made', ''],
];

function fmtStat(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v}${unit || ''}`;
}

/**
 * Live-stat comparison rows (home vs away). A missing value renders as '—',
 * never 0. `share` is the home fraction of the pair (0..1) for the bar, or
 * null when the pair cannot be compared. Row set follows the sport, so a
 * basketball boxscore renders rebounds/turnovers rather than shots/corners.
 */
function statRows(analysis) {
  const stats = analysis && analysis.stats;
  if (!stats || !stats.home || !stats.away) return [];
  const sport = stats.sport || (analysis && analysis.sport);
  const rowsDef = sport === 'basketball' ? STAT_ROWS_BASKETBALL : STAT_ROWS;
  const h = stats.home, a = stats.away;
  const rows = [];
  for (const [field, label, unit] of rowsDef) {
    const hv = h[field], av = a[field];
    if (hv == null && av == null) continue;
    const total = (hv || 0) + (av || 0);
    rows.push({
      key: field,
      label,
      home: fmtStat(hv, unit),
      away: fmtStat(av, unit),
      share: total > 0 ? (hv || 0) / total : null,
    });
  }
  return rows;
}

/* ------------------------------------------------------------- markets */

const MARKET_LABELS = {
  total_goals: 'Goals',
  total_points: 'Total points',
  team_goals: 'Team goals',
  double_chance: 'Double chance',
  corners: 'Corners',
  team_corners: 'Team corners',
  shots: 'Shots',
  cards: 'Cards',
  team_cards: 'Team cards',
  btts: 'BTTS',
};

function marketSideLabel(m, home, away) {
  const sideName = s => (s === 'home' ? home : s === 'away' ? away : null);
  // New-format team markets carry team + dir fields (side may be 'home_over' etc.)
  if (m.team && m.dir) {
    const dirLabel = m.dir === 'over' ? 'Over' : 'Under';
    const unit = m.market === 'team_goals' ? 'goals' : m.market === 'team_corners' ? 'corners' : 'cards';
    return `${sideName(m.team) || m.team} ${dirLabel} ${m.line} ${unit}`;
  }
  switch (m.market) {
    case 'total_goals': return `${m.side === 'over' ? 'Over' : 'Under'} ${m.line} goals`;
    case 'total_points': return `${m.side === 'over' ? 'Over' : 'Under'} ${m.line} points`;
    case 'team_goals': return `${sideName(m.side) || m.side} to score`;
    case 'double_chance': return `Double chance ${m.side}`;
    case 'corners': return `${m.side === 'over' ? 'Over' : 'Under'} ${m.line} corners`;
    case 'shots': return `${m.side === 'over' ? 'Over' : 'Under'} ${m.line} shots`;
    case 'team_corners': return `${sideName(m.side) || m.side} over ${m.line} corners`;
    case 'cards': return `${m.side === 'over' ? 'Over' : 'Under'} ${m.line} cards`;
    case 'team_cards': return `${sideName(m.side) || m.side} over ${m.line} cards`;
    case 'btts': return m.side === 'yes' ? 'BTTS Yes' : 'BTTS No';
    default: return m.side || m.market;
  }
}

/**
 * Available prediction markets, grouped to one row per (market, line) — the
 * side the model favours. Settled markets (won/lost) are counted, never shown
 * as predictions. Returns { rows, settledCount }.
 */
function marketRows(analysis) {
  const markets = analysis && analysis.markets;
  if (!Array.isArray(markets)) return { rows: [], settledCount: 0 };
  const { home, away } = teamNames(analysis);
  let settledCount = 0;
  const groups = new Map();
  for (const m of markets) {
    if (!m) continue;
    if (m.status === 'won' || m.status === 'lost') { settledCount += 1; continue; }
    if (m.status !== 'available' || !Number.isFinite(m.probability)) continue;
    const gk = `${m.market}|${m.line == null ? '' : m.line}|${m.side || ''}|${m.team || ''}|${m.dir || ''}`;
    const cur = groups.get(gk);
    if (!cur || m.probability > cur.probability) {
      groups.set(gk, { ...m });
    }
  }
  const rows = [...groups.values()]
    .sort((x, y) => y.probability - x.probability)
    .slice(0, 12)
    .map(m => ({
      key: m.key,
      market: MARKET_LABELS[m.market] || m.market,
      label: marketSideLabel(m, home, away),
      display: formatPercent(m.probability),
    }));
  return { rows, settledCount };
}

/** "Why Apex predicts this" bullets, or []. */
function explanationRows(analysis) {
  const list = analysis && analysis.explanation;
  return Array.isArray(list) ? list.filter(x => typeof x === 'string' && x) : [];
}

/** Data-quality label, e.g. "Live stats: 12/19 fields". */
function dataQualityLabel(analysis) {
  const dq = analysis && analysis.data_quality;
  if (!dq) return null;
  if (dq.level === 'none' || !dq.stats_available) return 'Score and clock only — no live statistics';
  const stale = dq.stale ? ' (may be stale)' : '';
  return `Live stats: ${dq.stats_available}/${dq.stats_tracked} fields${stale}`;
}

/** Confidence label for the model inputs, or null. */
function confidenceLabel(analysis) {
  const c = analysis && analysis.confidence;
  if (!c || !c.level || c.level === 'unavailable') return null;
  return `Model confidence: ${c.level}`;
}

/** Factual bullets the backend supplied (never generated here). */
function factors(analysis) {
  return Array.isArray(analysis && analysis.factors) ? analysis.factors : [];
}

/* ------------------------------------------------------------- context block */

/** The Phase 9 context block (pre-game setting, key events, injuries), or null. */
function contextBlock(analysis) {
  return (analysis && analysis.context) || null;
}

/**
 * Key events, shaped for rendering. `when` reads "34' · P1" for soccer/basketball
 * alike; an event with no clock still renders, just without a time.
 */
function keyEvents(analysis) {
  const c = contextBlock(analysis);
  const list = c && Array.isArray(c.key_events) ? c.key_events : [];
  return list.map(ev => ({
    when: ev.clock
      ? (ev.period ? `${ev.clock} · P${ev.period}` : String(ev.clock))
      : (ev.period ? `P${ev.period}` : ''),
    team: ev.team || null,
    what: ev.type || (ev.scoring === true ? 'Score' : 'Event'),
    detail: ev.text || null,
    scoring: ev.scoring === true,
  }));
}

/** Injuries, shaped for rendering; the player name always has a fallback. */
function injuries(analysis) {
  const c = contextBlock(analysis);
  const list = c && Array.isArray(c.injuries) ? c.injuries : [];
  return list.map(inj => ({
    who: inj.playerName || 'Unknown player',
    position: inj.position || null,
    team: inj.teamName || null,
    status: inj.status || inj.rawStatus || null,
    detail: inj.detail || null,
  }));
}

/**
 * Pre-game setting as label/value lines (venue, kick-off, each side's record),
 * or null when nothing is known — so the caller drops the block rather than
 * rendering empty rows.
 */
function pregameContext(analysis) {
  const c = contextBlock(analysis);
  const p = c && c.pregame;
  if (!p) return null;
  const lines = [];
  if (p.venue) lines.push({ label: 'Venue', value: p.venue });
  if (p.kickoff) lines.push({ label: 'Kick-off', value: String(p.kickoff) });
  if (p.home && p.home.record) lines.push({ label: `${p.home.name || 'Home'} record`, value: p.home.record });
  if (p.away && p.away.record) lines.push({ label: `${p.away.name || 'Away'} record`, value: p.away.record });
  return lines.length ? { lines } : null;
}

/** "updated Ns ago" for the summary read (events/injuries), or null. */
function contextUpdatedLabel(analysis) {
  const c = contextBlock(analysis);
  return (c && c.updated_label) || null;
}

/** The data-tier label ("Full live data", "Score and time only"), or null. */
function tierLabel(analysis) {
  return (analysis && analysis.data_tier_label) || null;
}

/** True when the context block carries anything worth a "Match context" section. */
function hasContext(analysis) {
  return keyEvents(analysis).length > 0
    || injuries(analysis).length > 0
    || Boolean(pregameContext(analysis));
}

/** Freshness label, e.g. "updated 34s ago", or null. */
function stalenessLabel(analysis) {
  const f = analysis && analysis.freshness;
  return (f && f.updated_label) || null;
}

/** Poll interval in seconds, clamped to the backend's floor. */
function refreshSeconds(analysis) {
  const r = (analysis && analysis.refresh) || {};
  const suggested = Number.isFinite(r.suggested_seconds) ? r.suggested_seconds : 30;
  const min = Number.isFinite(r.min_seconds) ? r.min_seconds : 15;
  return Math.max(min, suggested);
}

/** Whether the screen should keep polling this game. */
function shouldPoll(analysis) {
  if (!analysis || !analysis.game_id) return false;
  const live = analysis.live || {};
  return live.status !== 'finished';
}

/** Candidate list for the "which game did you mean?" step. */
function candidateOptions(resolveResult) {
  const list = (resolveResult && Array.isArray(resolveResult.candidates)) ? resolveResult.candidates : [];
  return list.map(game => ({
    gameId: game.game_id,
    label: `${(game.home && game.home.name) || 'Home'} vs ${(game.away && game.away.name) || 'Away'}`,
    league: (game.league && game.league.name) || null,
    clock: clockLine(game),
    score: scoreLine(game),
    confidence: game.match ? game.match.confidence : null,
  }));
}

/** The two score sites whose match pages the feed can answer for. */
const SCORE_SITE_HOSTS = ['livescore.com', 'flashscore.com'];

/**
 * The same two sites, labelled for the on-screen prompt. The Live Analysis
 * screen tells the reader which links to paste — these are those links.
 */
const SCORE_SITE_LABELS = [
  { host: 'livescore.com', name: 'LiveScore' },
  { host: 'flashscore.com', name: 'FlashScore' },
];

/**
 * The standing explanation shown whenever the ship gate withholds the model
 * figures. It says plainly that this is deliberate validation rather than a
 * failed or missing result, so a reader never mistakes "withheld" for "broken".
 */
const WITHHELD_HINT =
  'Predictions appear here only after the model has passed live backtesting for this sport. '
  + 'Until then nothing is estimated or shown — the score, clock and context above are all real.';

/**
 * True when `text` is a complete http(s) link to a LiveScore / FlashScore page.
 * This is the client-side half of "paste a link and it just shows": the screen
 * auto-resolves such a link the moment it lands, so the user does not have to
 * press a button. It is deliberately host-only — the SERVER owns what a valid
 * match page is, so the client never second-guesses it, it only decides whether
 * the link is worth asking about right away.
 *
 * A bare host (a link still being typed) is NOT auto-resolvable; a sub-domain
 * that has a real path is.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isAutoResolvableLink(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  const m = /^https?:\/\/([^/?#\s]+)\/.+$/i.exec(trimmed);
  if (!m) return false;
  const host = m[1].toLowerCase().replace(/:\d+$/, '');
  return SCORE_SITE_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

module.exports = {
  VIEW_STATE,
  MESSAGES,
  describeLiveFailure,
  classifyResolveResult,
  classifyAnalysisResult,
  formatPercent,
  teamNames,
  scoreLine,
  clockLine,
  showsProbabilities,
  manualBadge,
  manualBadgeDetail,
  shareText,
  withheldNotice,
  probabilityRows,
  resultLabel,
  pickRows,
  projectionRows,
  factors,
  statRows,
  marketRows,
  explanationRows,
  dataQualityLabel,
  confidenceLabel,
  contextBlock,
  keyEvents,
  injuries,
  pregameContext,
  contextUpdatedLabel,
  tierLabel,
  hasContext,
  stalenessLabel,
  refreshSeconds,
  shouldPoll,
  candidateOptions,
  isAutoResolvableLink,
  SCORE_SITE_HOSTS,
  SCORE_SITE_LABELS,
  WITHHELD_HINT,
};
