/**
 * settlementService.js
 *
 * Centralised prediction settlement engine for Apex.
 *
 * Responsibilities:
 *   1. Determine whether a prediction WON, LOST, or remains PENDING.
 *   2. Validate that a match has genuinely finished with a verified score.
 *   3. Persist settlement results to Firestore.
 *   4. Expose helpers for the cron job and API endpoints.
 *
 * Settlement is idempotent: processing the same match twice produces the same
 * result and never creates duplicate records.
 */

// ──────────────────────────────────────────────────────────
// 1. Market settlement rules
// ──────────────────────────────────────────────────────────

/**
 * Master settlement function: given a market key, selection, and final score,
 * returns 'won', 'lost', or null (unsupported / cannot settle).
 *
 * @param {string}  market       - Market key (e.g. 'under_4_5_goals')
 * @param {string}  [selection]  - Selection value (e.g. 'YES', '1X', 'Home Win')
 * @param {number}  homeGoals    - Full-time home goals
 * @param {number}  awayGoals    - Full-time away goals
 * @param {Object}  [extra]      - Extra data (htHome, htAway, corners, etc.)
 * @returns {'won'|'lost'|null}
 */
function settleMarket(market, selection, homeGoals, awayGoals, extra = {}) {
  if (!isValidScore(homeGoals) || !isValidScore(awayGoals)) return null;

  const hg = Number(homeGoals);
  const ag = Number(awayGoals);
  const total = hg + ag;

  const m = String(market || '').toLowerCase().replace(/ /g, '_');

  // ── Dynamic-line markets (shots, basketball points) ──────────────
  // Market keys encode the line, e.g. total_shots_over_21_5 -> line 21.5
  const lineMatch = m.match(/(\d+)_(\d)$/);
  const parsedLine = lineMatch ? parseFloat(`${lineMatch[1]}.${lineMatch[2]}`) : null;

  // Football shots
  if (m.startsWith('total_shots_')) {
    const side = m.includes('_over_') ? 'over' : 'under';
    const line = parsedLine ?? extra.line ?? 21.5;
    const totalShots = extra.totalShots;
    if (!isValidScore(totalShots)) return null;
    return side === 'over'
      ? Number(totalShots) > line ? 'won' : 'lost'
      : Number(totalShots) < line ? 'won' : 'lost';
  }
  if (m.startsWith('home_shots_')) {
    const side = m.includes('_over_') ? 'over' : 'under';
    const line = parsedLine ?? extra.line ?? 10.5;
    const homeShots = extra.homeShots;
    if (!isValidScore(homeShots)) return null;
    return side === 'over'
      ? Number(homeShots) > line ? 'won' : 'lost'
      : Number(homeShots) < line ? 'won' : 'lost';
  }
  if (m.startsWith('away_shots_')) {
    const side = m.includes('_over_') ? 'over' : 'under';
    const line = parsedLine ?? extra.line ?? 10.5;
    const awayShots = extra.awayShots;
    if (!isValidScore(awayShots)) return null;
    return side === 'over'
      ? Number(awayShots) > line ? 'won' : 'lost'
      : Number(awayShots) < line ? 'won' : 'lost';
  }

  // Basketball (homeGoals/awayGoals carry final points for basketball)
  if (m === 'basketball_match_winner' || m === 'basketball_match_winner_home') {
    return hg > ag ? 'won' : 'lost';
  }
  if (m === 'basketball_match_winner_away') {
    return ag > hg ? 'won' : 'lost';
  }
  if (m.startsWith('basketball_total_points_')) {
    const side = m.includes('_over_') ? 'over' : 'under';
    const line = parsedLine ?? extra.line ?? 215.5;
    return side === 'over'
      ? total > line ? 'won' : 'lost'
      : total < line ? 'won' : 'lost';
  }
  if (m.startsWith('basketball_home_points_')) {
    const side = m.includes('_over_') ? 'over' : 'under';
    const line = parsedLine ?? extra.line ?? 105.5;
    return side === 'over'
      ? hg > line ? 'won' : 'lost'
      : hg < line ? 'won' : 'lost';
  }
  if (m.startsWith('basketball_away_points_')) {
    const side = m.includes('_over_') ? 'over' : 'under';
    const line = parsedLine ?? extra.line ?? 105.5;
    return side === 'over'
      ? ag > line ? 'won' : 'lost'
      : ag < line ? 'won' : 'lost';
  }

  switch (m) {
    // ── Goals totals ────────────────────────────────────
    case 'under_4_5_goals':
    case 'under_4_5_total_goals':
      return total < 5 ? 'won' : 'lost';

    case 'under_3_5_goals':
    case 'under_3_5_total_goals':
      return total < 4 ? 'won' : 'lost';

    case 'under_2_5_goals':
    case 'under_2_5_total_goals':
      return total < 3 ? 'won' : 'lost';

    case 'under_1_5_goals':
    case 'under_1_5_total_goals':
      return total < 2 ? 'won' : 'lost';

    case 'over_0_5_goals':
    case 'over_0_5_total_goals':
      return total >= 1 ? 'won' : 'lost';

    case 'over_1_5_goals':
    case 'over_1_5_total_goals':
      return total >= 2 ? 'won' : 'lost';

    case 'over_2_5_goals':
    case 'over_2_5_total_goals':
      return total >= 3 ? 'won' : 'lost';

    // ── Half-time goals ─────────────────────────────────
    case 'under_2_5_ht':
    case 'under_2_5_first_half':
    case 'under_2_5_first_half_goals': {
      const htHome = extra.htHome;
      const htAway = extra.htAway;
      if (!isValidScore(htHome) || !isValidScore(htAway)) return null;
      return (Number(htHome) + Number(htAway)) < 3 ? 'won' : 'lost';
    }

    case 'under_1_5_ht':
    case 'under_1_5_first_half':
    case 'under_1_5_first_half_goals': {
      const htHome = extra.htHome;
      const htAway = extra.htAway;
      if (!isValidScore(htHome) || !isValidScore(htAway)) return null;
      return (Number(htHome) + Number(htAway)) < 2 ? 'won' : 'lost';
    }

    // ── Corners ─────────────────────────────────────────
    case 'under_corners':
    case 'under_total_corners': {
      const totalCorners = extra.totalCorners;
      const line = extra.cornersLine || 10.5;
      if (!isValidScore(totalCorners)) return null;
      return Number(totalCorners) < line ? 'won' : 'lost';
    }

    case 'over_corners':
    case 'over_total_corners': {
      const totalCorners = extra.totalCorners;
      const line = extra.cornersLine || 10.5;
      if (!isValidScore(totalCorners)) return null;
      return Number(totalCorners) > line ? 'won' : 'lost';
    }

    // ── Bookings ─────────────────────────────────────────
    case 'under_bookings':
    case 'under_total_bookings':
    case 'under_cards': {
      const totalBookings = extra.totalBookings;
      const line = extra.bookingsLine || 3.5;
      if (!isValidScore(totalBookings)) return null;
      return Number(totalBookings) < line ? 'won' : 'lost';
    }

    case 'over_bookings':
    case 'over_total_bookings':
    case 'over_cards': {
      const totalBookings = extra.totalBookings;
      const line = extra.bookingsLine || 3.5;
      if (!isValidScore(totalBookings)) return null;
      return Number(totalBookings) > line ? 'won' : 'lost';
    }

    // ── Double chance ───────────────────────────────────
    case 'double_chance': {
      const sel = normaliseSelection(selection);
      if (sel === '1x' || sel === 'home_or_draw') {
        return (hg >= ag) ? 'won' : 'lost';
      }
      if (sel === 'x2' || sel === 'away_or_draw' || sel === 'draw_or_away') {
        return (ag >= hg) ? 'won' : 'lost';
      }
      if (sel === '12' || sel === 'home_or_away' || sel === 'no_draw') {
        return (hg !== ag) ? 'won' : 'lost';
      }
      return null;
    }

    // ── Match result (1X2) ──────────────────────────────
    case 'match_result':
    case '1x2': {
      const sel = normaliseSelection(selection);
      if (sel === 'home' || sel === 'home_win' || sel === '1') {
        return (hg > ag) ? 'won' : 'lost';
      }
      if (sel === 'draw' || sel === 'x') {
        return (hg === ag) ? 'won' : 'lost';
      }
      if (sel === 'away' || sel === 'away_win' || sel === '2') {
        return (hg < ag) ? 'won' : 'lost';
      }
      return null;
    }

    // ── Both teams to score ─────────────────────────────
    case 'btts':
    case 'both_teams_to_score': {
      const sel = normaliseSelection(selection);
      const bothScored = hg >= 1 && ag >= 1;
      if (sel === 'yes') return bothScored ? 'won' : 'lost';
      if (sel === 'no') return !bothScored ? 'won' : 'lost';
      return null;
    }

    default:
      return null; // Unsupported market — leave unsettled
  }
}

// ──────────────────────────────────────────────────────────
// 2. Helpers
// ──────────────────────────────────────────────────────────

function isValidScore(val) {
  if (val === undefined || val === null) return false;
  const n = Number(val);
  return !isNaN(n) && isFinite(n) && n >= 0;
}

function normaliseSelection(sel) {
  if (!sel) return '';
  return String(sel)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Determine whether a match status represents a genuinely finished match.
 * Supports ESPN status strings and normalised PitchAPI statuses.
 *
 * @param {string} status - Match state/status string
 * @returns {'finished'|'live'|'scheduled'|'postponed'|'cancelled'|'unknown'}
 */
function classifyMatchStatus(status) {
  if (!status) return 'unknown';
  const s = String(status).toLowerCase().trim();

  // Finished / full-time / AET / penalties / awarded (has a final result)
  if ([
    'post', 'ft', 'aet', 'finished', 'full-time', 'fulltime', 'complete', 'final',
    'after_extra_time', 'after_penalties', 'aet/pen', 'pen', 'ft_pen',
    'awarded', 'aw', 'wo', 'walkover',
  ].includes(s)) {
    return 'finished';
  }
  // Live / in-progress (football + basketball periods)
  if ([
    'in', 'live', '1h', '2h', 'ht', 'et', 'bt', 'p', 'in_progress', 'inprogress', 'halftime',
    'first_half', 'second_half', '1st_quarter', '2nd_quarter', '3rd_quarter', '4th_quarter',
    'quarter1', 'quarter2', 'quarter3', 'quarter4', 'q1', 'q2', 'q3', 'q4',
    'overtime', 'ot', 'intermission',
  ].includes(s)) {
    return 'live';
  }
  // Scheduled / upcoming
  if (['pre', 'scheduled', 'not_started', 'notstarted', 'ns', 'tbd'].includes(s)) {
    return 'scheduled';
  }
  // Postponed / suspended / interrupted — not ordinary completed
  if (['pst', 'postponed', 'delayed', 'susp', 'suspended', 'int', 'interrupted'].includes(s)) {
    return 'postponed';
  }
  // Cancelled / abandoned — not ordinary completed
  if (['canc', 'cancelled', 'canceled', 'abn', 'abandoned'].includes(s)) {
    return 'cancelled';
  }
  return 'unknown';
}

/**
 * Which extra statistic a market needs beyond FT score.
 * Returns null for score-only markets.
 */
function marketRequiresStatistic(market) {
  const m = normaliseMarketKey(market);
  if (!m) return null;
  if (m.includes('corner')) return 'corners';
  if (m.includes('booking') || m.includes('card')) return 'bookings';
  if (m.startsWith('total_shots_') || m.startsWith('home_shots_') || m.startsWith('away_shots_') || m.includes('shots')) {
    return 'shots';
  }
  if (m.includes('_ht') || m.includes('first_half') || m.includes('half_time') || m.includes('halftime')) {
    return 'ht';
  }
  return null;
}

/**
 * Resolve outcome when settleMarket returns null.
 * Missing required stats → 'pending'. Truly unsupported → 'void' once finished.
 */
function resolveNullOutcome(market, scoreData) {
  const needed = marketRequiresStatistic(market);
  if (needed === 'corners' && !isValidScore(scoreData.totalCorners)) return 'pending';
  if (needed === 'bookings' && !isValidScore(scoreData.totalBookings)) return 'pending';
  if (needed === 'shots') {
    const m = normaliseMarketKey(market);
    if (m.startsWith('home_shots_') && !isValidScore(scoreData.homeShots)) return 'pending';
    if (m.startsWith('away_shots_') && !isValidScore(scoreData.awayShots)) return 'pending';
    if (!isValidScore(scoreData.totalShots) && !isValidScore(scoreData.homeShots)) return 'pending';
  }
  if (needed === 'ht' && (!isValidScore(scoreData.htHome) || !isValidScore(scoreData.htAway))) {
    return 'pending';
  }
  // Unsupported market once the match is finished
  return 'void';
}

/**
 * Map a prediction's market key to the settlement-compatible key.
 * Handles uppercase type fields from the analyzeMatchServer response.
 */
function normaliseMarketKey(market) {
  if (!market) return '';
  return String(market).toLowerCase().replace(/ /g, '_');
}

// ──────────────────────────────────────────────────────────
// 3. Firestore persistence helpers
// ──────────────────────────────────────────────────────────

function getServerTimestamp(admin) {
  if (admin?.firestore?.FieldValue?.serverTimestamp) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  if (typeof admin?.firestore === 'function' && admin.firestore()?.FieldValue?.serverTimestamp) {
    return admin.firestore().FieldValue.serverTimestamp();
  }
  return new Date().toISOString();
}

/**
 * Save a prediction to Firestore (called when user unlocks prediction).
 *
 * @param {Object} admin   - firebase-admin instance
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.matchId
 * @param {string} params.sport
 * @param {string} params.leagueSlug
 * @param {string} params.league        - Display name
 * @param {string} params.homeName
 * @param {string} params.awayName
 * @param {string} params.homeTeamId
 * @param {string} params.awayTeamId
 * @param {string} params.matchDate     - ISO 8601 kickoff date
 * @param {Array}  params.predictions   - Array of { market, label, value, confidence, selection }
 * @param {Object} [logger]             - Winston logger (optional)
 * @returns {Promise<string>} Firestore document ID
 */
async function savePrediction(admin, params, logger) {
  const db = admin.firestore();
  const {
    userId, matchId, sport, leagueSlug, league,
    homeName, awayName, homeTeamId, awayTeamId,
    matchDate, predictions,
  } = params;

  // Idempotency: check if prediction for this user+match already exists
  const existingSnap = await db.collection('predictions')
    .where('userId', '==', userId)
    .where('matchId', '==', String(matchId))
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existingDoc = existingSnap.docs[0];
    if (logger) logger.info('Prediction already saved, returning existing', { docId: existingDoc.id, matchId });
    return existingDoc.id;
  }

  const docRef = await db.collection('predictions').add({
    userId,
    matchId: String(matchId),
    sport: sport || 'soccer',
    leagueSlug: leagueSlug || '',
    league: league || '',
    homeName: homeName || '',
    awayName: awayName || '',
    homeTeamId: String(homeTeamId || ''),
    awayTeamId: String(awayTeamId || ''),
    matchDate: matchDate || null,
    predictions: (predictions || []).map(p => ({
      market: normaliseMarketKey(p.market || p.type),
      label: p.label || '',
      value: p.value || '',
      confidence: p.confidence || 0,
      selection: p.selection || p.value || '',
    })),
    settlementStatus: 'pending',    // pending | settled
    settledAt: null,
    actualHomeScore: null,
    actualAwayScore: null,
    actualHtHome: null,
    actualHtAway: null,
    settlementSource: null,
    settlementVersion: 1,
    results: [],                     // Array of { market, outcome: 'won'|'lost'|'pending'|'void' }
    createdAt: getServerTimestamp(admin),
  });

  if (logger) logger.info('Prediction saved', { docId: docRef.id, matchId, userId });
  return docRef.id;
}

/**
 * Settle a single prediction document against a verified final score.
 *
 * @param {Object}  admin        - firebase-admin instance
 * @param {Object}  predictionDoc - Firestore document snapshot
 * @param {Object}  scoreData    - { homeGoals, awayGoals, htHome?, htAway?, totalCorners?, cornersLine?, matchStatus }
 * @param {string}  source       - Settlement data source (e.g. 'espn', 'pitchapi')
 * @param {Object}  [logger]
 * @returns {Promise<Object|null>} Settlement result or null if not settleable
 */
function _canResolvePendingMarkets(existingResults, scoreData) {
  const pending = (existingResults || []).filter(r => r.outcome === 'pending');
  if (pending.length === 0) return false;
  return pending.some(r => {
    const need = marketRequiresStatistic(r.market);
    if (need === 'corners') return isValidScore(scoreData.totalCorners);
    if (need === 'bookings') return isValidScore(scoreData.totalBookings);
    if (need === 'ht') return isValidScore(scoreData.htHome) && isValidScore(scoreData.htAway);
    if (need === 'shots') {
      const m = normaliseMarketKey(r.market);
      if (m.startsWith('home_shots_')) return isValidScore(scoreData.homeShots);
      if (m.startsWith('away_shots_')) return isValidScore(scoreData.awayShots);
      return isValidScore(scoreData.totalShots);
    }
    return false;
  });
}

async function settlePrediction(admin, predictionDoc, scoreData, source, logger) {
  const data = predictionDoc.data();

  const scoresMatch =
    data.actualHomeScore === scoreData.homeGoals &&
    data.actualAwayScore === scoreData.awayGoals;

  // Already fully settled — idempotency guard (unless version correction)
  if (data.settlementStatus === 'settled' && !scoreData.forceReconcile) {
    const priorPending = (data.results || []).some(r => r.outcome === 'pending');
    // Same score and no markets waiting on stats → skip
    if (scoresMatch && !priorPending) {
      return null;
    }
    // Settled but still has pending market rows — only rewrite if new stats arrived
    if (scoresMatch && priorPending && !_canResolvePendingMarkets(data.results, scoreData)) {
      return null;
    }
    if (!scoresMatch && logger) {
      logger.info('Score correction detected, reconciling', {
        docId: predictionDoc.id,
        oldScore: `${data.actualHomeScore}-${data.actualAwayScore}`,
        newScore: `${scoreData.homeGoals}-${scoreData.awayGoals}`,
      });
    }
  }

  // Pending with same verified score and no new stats → avoid rewriting every cron tick
  if (
    data.settlementStatus === 'pending' &&
    !scoreData.forceReconcile &&
    !scoreData.voidAll &&
    scoresMatch &&
    Array.isArray(data.results) &&
    data.results.length > 0 &&
    !_canResolvePendingMarkets(data.results, scoreData)
  ) {
    return null;
  }

  // Cancelled / abandoned → void all markets (not ordinary completed)
  if (scoreData.matchStatus === 'cancelled' || scoreData.voidAll) {
    const results = (data.predictions || []).map(pred => ({
      market: pred.market,
      label: pred.label,
      outcome: 'void',
    }));
    await predictionDoc.ref.update({
      settlementStatus: 'settled',
      settledAt: getServerTimestamp(admin),
      actualHomeScore: isValidScore(scoreData.homeGoals) ? scoreData.homeGoals : null,
      actualAwayScore: isValidScore(scoreData.awayGoals) ? scoreData.awayGoals : null,
      settlementSource: source || 'unknown',
      settlementVersion: (data.settlementVersion || 0) + 1,
      results,
      voidReason: scoreData.voidReason || 'match_cancelled_or_abandoned',
    });
    if (logger) logger.info('Prediction voided (cancelled/abandoned)', {
      docId: predictionDoc.id,
      matchId: data.matchId,
      source,
    });
    return { docId: predictionDoc.id, results, fullySettled: true };
  }

  // Settle each market; missing required stats stay pending (never invent zeros)
  const results = (data.predictions || []).map(pred => {
    const outcome = settleMarket(
      pred.market,
      pred.selection || pred.value,
      scoreData.homeGoals,
      scoreData.awayGoals,
      {
        htHome: scoreData.htHome,
        htAway: scoreData.htAway,
        totalCorners: scoreData.totalCorners,
        cornersLine: pred.cornersLine || pred.line || scoreData.cornersLine,
        totalBookings: scoreData.totalBookings,
        bookingsLine: pred.bookingsLine || pred.line || scoreData.bookingsLine,
        homeShots: scoreData.homeShots,
        awayShots: scoreData.awayShots,
        totalShots: scoreData.totalShots,
        line: pred.line,
      }
    );
    return {
      market: pred.market,
      label: pred.label,
      outcome: outcome || resolveNullOutcome(pred.market, scoreData),
    };
  });

  const hasPending = results.some(r => r.outcome === 'pending');
  const fullySettled = !hasPending;

  const updateData = {
    settlementStatus: fullySettled ? 'settled' : 'pending',
    settledAt: fullySettled ? getServerTimestamp(admin) : (data.settledAt || null),
    actualHomeScore: scoreData.homeGoals,
    actualAwayScore: scoreData.awayGoals,
    actualHtHome: scoreData.htHome ?? data.actualHtHome ?? null,
    actualHtAway: scoreData.htAway ?? data.actualHtAway ?? null,
    actualTotalCorners: scoreData.totalCorners ?? data.actualTotalCorners ?? null,
    actualTotalBookings: scoreData.totalBookings ?? data.actualTotalBookings ?? null,
    actualHomeShots: scoreData.homeShots ?? data.actualHomeShots ?? null,
    actualAwayShots: scoreData.awayShots ?? data.actualAwayShots ?? null,
    actualTotalShots: scoreData.totalShots ?? data.actualTotalShots ?? null,
    settlementSource: source || 'unknown',
    settlementVersion: (data.settlementVersion || 0) + 1,
    results,
    resultRetrievedAt: getServerTimestamp(admin),
    awaitingStatistics: hasPending,
  };

  await predictionDoc.ref.update(updateData);

  if (logger) {
    logger.info(fullySettled ? 'Prediction settled' : 'Prediction partially settled (awaiting stats)', {
      docId: predictionDoc.id,
      matchId: data.matchId,
      score: `${scoreData.homeGoals}-${scoreData.awayGoals}`,
      results: results.map(r => `${r.market}:${r.outcome}`).join(', '),
      source,
      fullySettled,
    });
  }

  return { docId: predictionDoc.id, results, fullySettled };
}

/**
 * Fetch all unsettled predictions for a batch of match IDs.
 *
 * @param {Object} admin
 * @param {string[]} matchIds
 * @returns {Promise<Object[]>} Array of Firestore document snapshots
 */
async function getUnsettledPredictions(admin, matchIds) {
  if (!matchIds || matchIds.length === 0) return [];
  const db = admin.firestore();

  // Firestore 'in' queries are limited to 30 items (10 in older SDK versions)
  const chunks = [];
  for (let i = 0; i < matchIds.length; i += 10) {
    chunks.push(matchIds.slice(i, i + 10));
  }

  const results = [];
  for (const chunk of chunks) {
    const snap = await db.collection('predictions')
      .where('matchId', 'in', chunk)
      .where('settlementStatus', '==', 'pending')
      .get();
    snap.docs.forEach(doc => results.push(doc));
  }

  return results;
}

/**
 * Fetch prediction history for a user with optional filters.
 *
 * @param {Object}  admin
 * @param {string}  userId
 * @param {Object}  [filters]
 * @param {string}  [filters.status]  - 'pending' | 'won' | 'lost' | 'all'
 * @param {number}  [filters.limit]   - Max results (default 50)
 * @returns {Promise<Object[]>}
 */
async function getUserPredictionHistory(admin, userId, filters = {}) {
  const db = admin.firestore();
  let query = db.collection('predictions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc');

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'won' || filters.status === 'lost') {
      // For won/lost, we need settled predictions where any result matches
      query = query.where('settlementStatus', '==', 'settled');
    } else if (filters.status === 'pending') {
      query = query.where('settlementStatus', '==', 'pending');
    }
  }

  const limit = Math.min(filters.limit || 50, 200);
  query = query.limit(limit);

  const snap = await query.get();

  let docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Post-filter for won/lost (check individual market results)
  if (filters.status === 'won') {
    docs = docs.filter(d => d.results && d.results.some(r => r.outcome === 'won'));
  } else if (filters.status === 'lost') {
    docs = docs.filter(d => d.results && d.results.every(r => r.outcome === 'lost' || r.outcome === 'void'));
  }

  return docs;
}

/**
 * Calculate user prediction statistics from settled predictions.
 *
 * @param {Object} admin
 * @param {string} userId
 * @returns {Promise<Object>} { totalSettled, totalWon, totalLost, totalPending, totalVoid, winRate }
 */
async function getUserPredictionStats(admin, userId) {
  const db = admin.firestore();

  // Fetch all predictions for this user
  const allSnap = await db.collection('predictions')
    .where('userId', '==', userId)
    .get();

  let totalSettled = 0;
  let totalWon = 0;
  let totalLost = 0;
  let totalPending = 0;
  let totalVoid = 0;
  let marketWins = 0;
  let marketLosses = 0;

  allSnap.docs.forEach(doc => {
    const data = doc.data();
    if (data.settlementStatus === 'pending') {
      totalPending++;
    } else if (data.settlementStatus === 'settled') {
      totalSettled++;
      const results = data.results || [];
      results.forEach(r => {
        if (r.outcome === 'won') marketWins++;
        else if (r.outcome === 'lost') marketLosses++;
        else if (r.outcome === 'void') totalVoid++;
      });

      // A prediction doc is "won" if at least one market won
      const hasWin = results.some(r => r.outcome === 'won');
      const allLost = results.every(r => r.outcome === 'lost' || r.outcome === 'void');
      if (hasWin) totalWon++;
      else if (allLost) totalLost++;
    }
  });

  const winDenom = marketWins + marketLosses;
  const winRate = winDenom > 0 ? Number(((marketWins / winDenom) * 100).toFixed(1)) : 0;

  return {
    totalPredictions: allSnap.size,
    totalSettled,
    totalWon,
    totalLost,
    totalPending,
    totalVoid,
    marketWins,
    marketLosses,
    winRate,
  };
}

/**
 * Look up the settlement for a specific match (and optional user).
 *
 * @param {Object} admin
 * @param {string} matchId
 * @param {string} [userId]
 * @returns {Promise<Object|null>}
 */
async function getMatchSettlement(admin, matchId, userId = null) {
  if (!matchId) return null;
  const db = admin.firestore();
  let query = db.collection('predictions').where('matchId', '==', String(matchId));
  if (userId) {
    query = query.where('userId', '==', String(userId));
  }
  const snap = await query.limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {
    id: doc.id,
    ...doc.data(),
  };
}

const PENDING_BATCH_LIMIT = 200;
const MAX_SETTLEMENT_FETCH_FAILURES = 8;
const SETTLEMENT_BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extract verified scores + stats from ESPN, normalized, or PitchAPI payloads.
 * Never invents missing statistics as zero.
 *
 * @param {Object} summary
 * @returns {Object} Extracted settlement fields
 */
function extractMatchResultFromSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return { matchStatus: 'unknown', homeGoals: null, awayGoals: null };
  }

  let matchStatus = 'unknown';
  let homeGoals = null;
  let awayGoals = null;
  let htHome = null;
  let htAway = null;
  let totalCorners = null;
  let totalBookings = null;
  let homeShots = null;
  let awayShots = null;
  let totalShots = null;
  const providerStatus = summary._providerStatus || null;

  // Boxscore statistics (ESPN)
  if (summary.boxscore?.teams && Array.isArray(summary.boxscore.teams)) {
    const teams = summary.boxscore.teams;
    const findStat = (teamStats, names) => {
      const s = teamStats?.statistics?.find(i => names.includes(i.name) || names.includes(i.label));
      if (!s) return null;
      const n = parseFloat(s.displayValue ?? s.value);
      return Number.isFinite(n) ? n : null;
    };
    const hCorners = findStat(teams[0], ['wonCorners', 'cornerKicks', 'corners']);
    const aCorners = findStat(teams[1], ['wonCorners', 'cornerKicks', 'corners']);
    if (isValidScore(hCorners) && isValidScore(aCorners)) {
      totalCorners = hCorners + aCorners;
    }

    const hYellow = findStat(teams[0], ['yellowCards', 'yellow_cards']);
    const aYellow = findStat(teams[1], ['yellowCards', 'yellow_cards']);
    const hRed = findStat(teams[0], ['redCards', 'red_cards']);
    const aRed = findStat(teams[1], ['redCards', 'red_cards']);
    if (isValidScore(hYellow) && isValidScore(aYellow)) {
      // Red cards may legitimately be absent from some feeds; only add when present
      totalBookings = hYellow + aYellow
        + (isValidScore(hRed) ? hRed : 0)
        + (isValidScore(aRed) ? aRed : 0);
    }

    const hShots = findStat(teams[0], ['totalShots', 'shots', 'shotsTotal']);
    const aShots = findStat(teams[1], ['totalShots', 'shots', 'shotsTotal']);
    if (isValidScore(hShots)) homeShots = hShots;
    if (isValidScore(aShots)) awayShots = aShots;
    if (homeShots != null && awayShots != null) {
      totalShots = homeShots + awayShots;
    }
  } else if (summary.stats) {
    if (isValidScore(summary.stats.totalCorners)) {
      totalCorners = Number(summary.stats.totalCorners);
    } else if (isValidScore(summary.stats.homeCorners) && isValidScore(summary.stats.awayCorners)) {
      totalCorners = Number(summary.stats.homeCorners) + Number(summary.stats.awayCorners);
    }
    if (isValidScore(summary.stats.totalBookings)) {
      totalBookings = Number(summary.stats.totalBookings);
    } else if (isValidScore(summary.stats.homeYellowCards) && isValidScore(summary.stats.awayYellowCards)) {
      totalBookings = Number(summary.stats.homeYellowCards) + Number(summary.stats.awayYellowCards)
        + (isValidScore(summary.stats.homeRedCards) ? Number(summary.stats.homeRedCards) : 0)
        + (isValidScore(summary.stats.awayRedCards) ? Number(summary.stats.awayRedCards) : 0);
    }
    if (isValidScore(summary.stats.homeShots)) homeShots = Number(summary.stats.homeShots);
    if (isValidScore(summary.stats.awayShots)) awayShots = Number(summary.stats.awayShots);
    if (isValidScore(summary.stats.totalShots)) {
      totalShots = Number(summary.stats.totalShots);
    } else if (homeShots != null && awayShots != null) {
      totalShots = homeShots + awayShots;
    }
  }

  // Format 1: ESPN summary
  const competition = summary.header?.competitions?.[0] || summary.competitions?.[0];
  if (competition) {
    const state = competition.status?.type?.state
      || competition.status?.type?.name
      || competition.status?.state
      || competition.status?.type?.shortDetail;
    matchStatus = classifyMatchStatus(state);

    const homeComp = competition.competitors?.find(c => c.homeAway === 'home') || competition.competitors?.[0];
    const awayComp = competition.competitors?.find(c => c.homeAway === 'away') || competition.competitors?.[1];

    if (homeComp && awayComp) {
      const rawHg = homeComp.score?.value ?? homeComp.score;
      const rawAg = awayComp.score?.value ?? awayComp.score;
      if (isValidScore(rawHg) && isValidScore(rawAg)) {
        homeGoals = Number(rawHg);
        awayGoals = Number(rawAg);
      }

      const homeLines = homeComp.linescores || [];
      const awayLines = awayComp.linescores || [];
      if (homeLines.length > 0 && awayLines.length > 0) {
        const hPeriod1 = homeLines[0]?.value ?? homeLines[0];
        const aPeriod1 = awayLines[0]?.value ?? awayLines[0];
        if (isValidScore(hPeriod1) && isValidScore(aPeriod1)) {
          htHome = Number(hPeriod1);
          htAway = Number(aPeriod1);
        }
      } else if (Array.isArray(competition.linescores) && competition.linescores.length > 0) {
        const entry = competition.linescores[0];
        if (isValidScore(entry.home) && isValidScore(entry.away)) {
          htHome = Number(entry.home);
          htAway = Number(entry.away);
        }
      }
    }
  }
  // Format 2: Normalized { status, score: { home, away } }
  else if (summary.status != null && summary.score) {
    matchStatus = classifyMatchStatus(
      typeof summary.status === 'object'
        ? (summary.status.state || summary.status.type || summary.status)
        : summary.status
    );
    const rawHg = summary.score.home?.current ?? summary.score.home?.total ?? summary.score.home;
    const rawAg = summary.score.away?.current ?? summary.score.away?.total ?? summary.score.away;
    if (isValidScore(rawHg) && isValidScore(rawAg)) {
      homeGoals = Number(rawHg);
      awayGoals = Number(rawAg);
    }
    const rawHtH = summary.score.home?.period1 ?? summary.score.home?.halftime;
    const rawHtA = summary.score.away?.period1 ?? summary.score.away?.halftime;
    if (isValidScore(rawHtH) && isValidScore(rawHtA)) {
      htHome = Number(rawHtH);
      htAway = Number(rawHtA);
    }
  }
  // Format 3: PitchAPI / SportsData normalized fixture
  // { fixture: { status }, homeTeam: { score }, awayTeam: { score } }
  else if (summary.fixture || summary.homeTeam || summary.awayTeam) {
    const rawStatus = summary.fixture?.status || summary.status || summary.fixture?.rawStatus;
    matchStatus = classifyMatchStatus(
      typeof rawStatus === 'object' ? (rawStatus.state || rawStatus.type || rawStatus) : rawStatus
    );
    const rawHg = summary.homeTeam?.score ?? summary.score_home;
    const rawAg = summary.awayTeam?.score ?? summary.score_away;
    if (isValidScore(rawHg) && isValidScore(rawAg)) {
      homeGoals = Number(rawHg);
      awayGoals = Number(rawAg);
    }
  }

  return {
    matchStatus,
    providerStatus: providerStatus || matchStatus,
    homeGoals,
    awayGoals,
    htHome,
    htAway,
    totalCorners,
    totalBookings,
    homeShots,
    awayShots,
    totalShots,
    settlementSource: summary._settlementSource || null,
  };
}

function _shouldBackoff(docData, now = Date.now()) {
  const failures = Number(docData.settlementFetchFailures || 0);
  if (failures <= 0) return false;
  const lastAt = docData.lastSettlementAttemptAt
    ? new Date(docData.lastSettlementAttemptAt).getTime()
    : 0;
  if (!lastAt || Number.isNaN(lastAt)) return false;
  const wait = Math.min(
    SETTLEMENT_BACKOFF_BASE_MS * Math.pow(2, Math.min(failures - 1, 5)),
    6 * 60 * 60 * 1000 // cap 6h
  );
  return now - lastAt < wait;
}

/**
 * Automatically fetch upstream match data for pending predictions,
 * check if the match finished, extract score, and settle.
 *
 * Prioritizes past kickoffs, supports ESPN + PitchAPI summary shapes,
 * and keeps statistic markets pending until verified data arrives.
 *
 * @param {Object} admin - firebase-admin
 * @param {Function} fetchMatchSummary - async function(sport, leagueSlug, matchId)
 * @param {Object} [logger]
 * @returns {Promise<Object>}
 */
async function autoSettleFinishedMatches(admin, fetchMatchSummary, logger) {
  const startedAt = new Date().toISOString();
  const db = admin.firestore();
  const pendingSnap = await db.collection('predictions')
    .where('settlementStatus', '==', 'pending')
    .limit(PENDING_BATCH_LIMIT)
    .get();

  if (pendingSnap.empty) {
    return {
      checked: 0,
      settled: 0,
      partial: 0,
      skipped: 0,
      awaitingStats: 0,
      errors: 0,
      flagged: 0,
      results: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // Prioritize: past kickoffs first, then oldest created. Avoids starvation of finished matches.
  const now = Date.now();
  const sortedDocs = [...pendingSnap.docs].sort((a, b) => {
    const da = a.data();
    const db_ = b.data();
    const ta = da.matchDate ? new Date(da.matchDate).getTime() : Number.POSITIVE_INFINITY;
    const tb = db_.matchDate ? new Date(db_.matchDate).getTime() : Number.POSITIVE_INFINITY;
    const aPast = Number.isFinite(ta) && ta <= now ? 0 : 1;
    const bPast = Number.isFinite(tb) && tb <= now ? 0 : 1;
    if (aPast !== bPast) return aPast - bPast;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });

  const matchGroups = new Map();
  sortedDocs.forEach(doc => {
    const data = doc.data();
    if (_shouldBackoff(data, now)) return;
    if (Number(data.settlementFetchFailures || 0) >= MAX_SETTLEMENT_FETCH_FAILURES) return;

    const mId = String(data.matchId);
    if (!matchGroups.has(mId)) {
      matchGroups.set(mId, {
        matchId: mId,
        sport: data.sport || 'soccer',
        leagueSlug: data.leagueSlug || '',
        docs: [],
      });
    }
    matchGroups.get(mId).docs.push(doc);
  });

  let settledCount = 0;
  let partialCount = 0;
  let skippedCount = 0;
  let awaitingStats = 0;
  let errorCount = 0;
  let flaggedCount = 0;
  const settlementReports = [];

  for (const [matchId, group] of matchGroups.entries()) {
    try {
      if (typeof fetchMatchSummary !== 'function') {
        skippedCount++;
        continue;
      }

      const summary = await fetchMatchSummary(group.sport, group.leagueSlug, group.matchId);
      if (!summary) {
        skippedCount++;
        // Record fetch failure + backoff metadata on each doc
        for (const doc of group.docs) {
          const data = doc.data();
          const failures = Number(data.settlementFetchFailures || 0) + 1;
          const patch = {
            settlementFetchFailures: failures,
            lastSettlementAttemptAt: new Date().toISOString(),
            lastSettlementError: 'summary_unavailable',
          };
          if (failures >= MAX_SETTLEMENT_FETCH_FAILURES) {
            patch.settlementNeedsReview = true;
            flaggedCount++;
            if (logger) {
              logger.warn('Fixture flagged for investigation after repeated fetch failures', {
                fixtureId: matchId,
                predictionId: doc.id,
                failures,
                provider: String(matchId).startsWith('pa-') ? 'pitchapi' : 'espn',
                timestamp: new Date().toISOString(),
              });
            }
          }
          await doc.ref.update(patch);
        }
        if (logger) {
          logger.info('Settlement fetch returned empty', {
            fixtureId: matchId,
            sport: group.sport,
            leagueSlug: group.leagueSlug,
            timestamp: new Date().toISOString(),
          });
        }
        continue;
      }

      const extracted = extractMatchResultFromSummary(summary);
      const {
        matchStatus, homeGoals, awayGoals, htHome, htAway,
        totalCorners, totalBookings, homeShots, awayShots, totalShots,
      } = extracted;
      const source = extracted.settlementSource
        || summary._settlementSource
        || (String(matchId).startsWith('pa-') ? 'pitchapi-auto' : 'espn-auto');

      if (logger) {
        logger.info('Fixture status for settlement', {
          fixtureId: matchId,
          providerStatus: extracted.providerStatus,
          normalizedStatus: matchStatus,
          hasScore: isValidScore(homeGoals) && isValidScore(awayGoals),
          source,
          timestamp: new Date().toISOString(),
        });
      }

      // Postponed / live / scheduled — leave pending, clear transient fetch failures on success
      if (matchStatus === 'postponed' || matchStatus === 'live' || matchStatus === 'scheduled' || matchStatus === 'unknown') {
        skippedCount++;
        for (const doc of group.docs) {
          await doc.ref.update({
            lastSettlementAttemptAt: new Date().toISOString(),
            lastKnownFixtureStatus: matchStatus,
            settlementFetchFailures: 0,
            lastSettlementError: null,
          });
        }
        continue;
      }

      // Cancelled / abandoned → void
      if (matchStatus === 'cancelled') {
        for (const doc of group.docs) {
          const res = await settlePrediction(admin, doc, {
            matchStatus: 'cancelled',
            voidAll: true,
            voidReason: 'match_cancelled_or_abandoned',
            homeGoals,
            awayGoals,
          }, source, logger);
          if (res) {
            settledCount++;
            settlementReports.push(res);
          }
        }
        continue;
      }

      if (matchStatus === 'finished' && isValidScore(homeGoals) && isValidScore(awayGoals)) {
        for (const doc of group.docs) {
          const res = await settlePrediction(admin, doc, {
            homeGoals,
            awayGoals,
            htHome,
            htAway,
            totalCorners,
            totalBookings,
            homeShots,
            awayShots,
            totalShots,
            matchStatus: 'finished',
          }, source, logger);
          if (res) {
            if (res.fullySettled) settledCount++;
            else {
              partialCount++;
              awaitingStats++;
            }
            settlementReports.push(res);
            await doc.ref.update({
              settlementFetchFailures: 0,
              lastSettlementError: null,
              lastKnownFixtureStatus: 'finished',
              lastSettlementAttemptAt: new Date().toISOString(),
            });
          }
        }
      } else if (matchStatus === 'finished') {
        // Finished but score not yet verified — retry later, do not invent
        skippedCount++;
        for (const doc of group.docs) {
          const data = doc.data();
          const failures = Number(data.settlementFetchFailures || 0) + 1;
          await doc.ref.update({
            settlementFetchFailures: failures,
            lastSettlementAttemptAt: new Date().toISOString(),
            lastSettlementError: 'finished_without_verified_score',
            lastKnownFixtureStatus: 'finished',
            settlementNeedsReview: failures >= MAX_SETTLEMENT_FETCH_FAILURES,
          });
          if (failures >= MAX_SETTLEMENT_FETCH_FAILURES) flaggedCount++;
        }
        if (logger) {
          logger.warn('Finished fixture missing verified score', {
            fixtureId: matchId,
            source,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      errorCount++;
      if (logger) logger.warn('Failed auto-settling match', {
        fixtureId: matchId,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
      for (const doc of group.docs) {
        try {
          const data = doc.data();
          await doc.ref.update({
            settlementFetchFailures: Number(data.settlementFetchFailures || 0) + 1,
            lastSettlementAttemptAt: new Date().toISOString(),
            lastSettlementError: String(err.message || 'unknown_error').slice(0, 200),
          });
        } catch (_) { /* ignore meta update failure */ }
      }
    }
  }

  const report = {
    checked: pendingSnap.size,
    settled: settledCount,
    partial: partialCount,
    skipped: skippedCount,
    awaitingStats,
    errors: errorCount,
    flagged: flaggedCount,
    matchGroups: matchGroups.size,
    results: settlementReports,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  if (logger) {
    logger.info('Settlement job summary', report);
  }

  return report;
}

/**
 * Reconciliation: find stuck pending predictions and flag/repair unambiguous cases.
 *
 * @param {Object} admin
 * @param {Function} fetchMatchSummary
 * @param {Object} [logger]
 * @returns {Promise<Object>}
 */
async function reconcileStuckPredictions(admin, fetchMatchSummary, logger) {
  const db = admin.firestore();
  const snap = await db.collection('predictions')
    .where('settlementStatus', '==', 'pending')
    .limit(PENDING_BATCH_LIMIT)
    .get();

  const summary = {
    pendingTotal: snap.size,
    completedStillPending: 0,
    missingResults: 0,
    awaitingStatistics: 0,
    needsReview: 0,
    repaired: 0,
  };

  if (snap.empty) return summary;

  // Re-run settlement on the same batch — repairs unambiguous finished matches
  const report = await autoSettleFinishedMatches(admin, fetchMatchSummary, logger);
  summary.repaired = report.settled || 0;
  summary.awaitingStatistics = report.awaitingStats || 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.settlementNeedsReview) summary.needsReview++;
    if (data.awaitingStatistics) summary.awaitingStatistics++;
    if (data.lastKnownFixtureStatus === 'finished' && data.settlementStatus === 'pending') {
      summary.completedStillPending++;
      if (!isValidScore(data.actualHomeScore)) summary.missingResults++;
    }
  }

  if (logger) logger.info('Reconciliation summary', summary);
  return summary;
}

/**
 * Internal health snapshot for settlement monitoring.
 */
async function getSettlementHealthSummary(admin) {
  const db = admin.firestore();
  const pendingSnap = await db.collection('predictions')
    .where('settlementStatus', '==', 'pending')
    .limit(PENDING_BATCH_LIMIT)
    .get();

  let awaitingStatistics = 0;
  let needsReview = 0;
  let finishedStillPending = 0;

  pendingSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.awaitingStatistics) awaitingStatistics++;
    if (d.settlementNeedsReview) needsReview++;
    if (d.lastKnownFixtureStatus === 'finished') finishedStillPending++;
  });

  return {
    pendingPredictions: pendingSnap.size,
    finishedStillPending,
    awaitingStatistics,
    needsReview,
    checkedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────

module.exports = {
  settleMarket,
  classifyMatchStatus,
  marketRequiresStatistic,
  resolveNullOutcome,
  extractMatchResultFromSummary,
  normaliseMarketKey,
  normaliseSelection,
  isValidScore,
  savePrediction,
  settlePrediction,
  getUnsettledPredictions,
  getUserPredictionHistory,
  getUserPredictionStats,
  getMatchSettlement,
  autoSettleFinishedMatches,
  reconcileStuckPredictions,
  getSettlementHealthSummary,
  PENDING_BATCH_LIMIT,
  MAX_SETTLEMENT_FETCH_FAILURES,
};
