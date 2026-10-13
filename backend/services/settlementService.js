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

    // ── Team-specific under goals ───────────────────────
    case 'home_team_under_2_5':
    case 'home_team_under_2_5_goals':
      return hg <= 2 ? 'won' : 'lost';

    case 'away_team_under_2_5':
    case 'away_team_under_2_5_goals':
      return ag <= 2 ? 'won' : 'lost';

    // ── Corners ─────────────────────────────────────────
    case 'under_corners': {
      const totalCorners = extra.totalCorners;
      const line = extra.cornersLine || 10.5;
      if (!isValidScore(totalCorners)) return null;
      return Number(totalCorners) < line ? 'won' : 'lost';
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

  // Finished / full-time
  if (['post', 'ft', 'aet', 'finished', 'full-time', 'fulltime', 'complete', 'final'].includes(s)) {
    return 'finished';
  }
  // Live / in-progress
  if (['in', 'live', '1h', '2h', 'ht', 'et', 'bt', 'p', 'in_progress', 'inprogress', 'halftime'].includes(s)) {
    return 'live';
  }
  // Scheduled / upcoming
  if (['pre', 'scheduled', 'not_started', 'notstarted', 'ns', 'tbd'].includes(s)) {
    return 'scheduled';
  }
  // Postponed
  if (['pst', 'postponed', 'delayed', 'susp', 'suspended', 'int', 'interrupted'].includes(s)) {
    return 'postponed';
  }
  // Cancelled / abandoned
  if (['canc', 'cancelled', 'canceled', 'abn', 'abandoned', 'aw', 'awarded', 'wo', 'walkover'].includes(s)) {
    return 'cancelled';
  }
  return 'unknown';
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
async function settlePrediction(admin, predictionDoc, scoreData, source, logger) {
  const data = predictionDoc.data();

  // Already settled — idempotency guard (unless version correction)
  if (data.settlementStatus === 'settled' && !scoreData.forceReconcile) {
    // Check if scores match — if they do, skip. If different, reconcile.
    if (data.actualHomeScore === scoreData.homeGoals &&
        data.actualAwayScore === scoreData.awayGoals) {
      return null; // Already settled with same score
    }
    // Score correction — proceed with reconciliation
    if (logger) logger.info('Score correction detected, reconciling', {
      docId: predictionDoc.id,
      oldScore: `${data.actualHomeScore}-${data.actualAwayScore}`,
      newScore: `${scoreData.homeGoals}-${scoreData.awayGoals}`,
    });
  }

  // Settle each market prediction
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
        cornersLine: scoreData.cornersLine,
      }
    );
    return {
      market: pred.market,
      label: pred.label,
      outcome: outcome || 'void', // null = unsupported market → void
    };
  });

  const updateData = {
    settlementStatus: 'settled',
    settledAt: getServerTimestamp(admin),
    actualHomeScore: scoreData.homeGoals,
    actualAwayScore: scoreData.awayGoals,
    actualHtHome: scoreData.htHome ?? null,
    actualHtAway: scoreData.htAway ?? null,
    settlementSource: source || 'unknown',
    settlementVersion: (data.settlementVersion || 0) + 1,
    results,
  };

  await predictionDoc.ref.update(updateData);

  if (logger) logger.info('Prediction settled', {
    docId: predictionDoc.id,
    matchId: data.matchId,
    score: `${scoreData.homeGoals}-${scoreData.awayGoals}`,
    results: results.map(r => `${r.market}:${r.outcome}`).join(', '),
    source,
  });

  return { docId: predictionDoc.id, results };
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

/**
 * Automatically fetch upstream match data for pending predictions,
 * check if the match finished, extract score, and settle.
 *
 * @param {Object} admin - firebase-admin
 * @param {Function} fetchMatchSummary - async function(sport, leagueSlug, matchId)
 * @param {Object} [logger]
 * @returns {Promise<{ checked: number, settled: number, errors: number, results: Array }>}
 */
async function autoSettleFinishedMatches(admin, fetchMatchSummary, logger) {
  const db = admin.firestore();
  const pendingSnap = await db.collection('predictions')
    .where('settlementStatus', '==', 'pending')
    .limit(50)
    .get();

  if (pendingSnap.empty) {
    return { checked: 0, settled: 0, errors: 0, results: [] };
  }

  // Group by matchId to avoid duplicate API requests
  const matchGroups = new Map();
  pendingSnap.docs.forEach(doc => {
    const data = doc.data();
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
  let errorCount = 0;
  const settlementReports = [];

  for (const [matchId, group] of matchGroups.entries()) {
    try {
      if (typeof fetchMatchSummary !== 'function') continue;

      const summary = await fetchMatchSummary(group.sport, group.leagueSlug, group.matchId);
      if (!summary) continue;

      let matchStatus = 'unknown';
      let homeGoals = null;
      let awayGoals = null;
      let htHome = null;
      let htAway = null;
      let totalCorners = null;

      // Format 1: ESPN summary { header: { competitions: [{ status, competitors }] } }
      const competition = summary.header?.competitions?.[0] || summary.competitions?.[0];
      if (competition) {
        const state = competition.status?.type?.state || competition.status?.state;
        matchStatus = classifyMatchStatus(state);

        const homeComp = competition.competitors?.find(c => c.homeAway === 'home');
        const awayComp = competition.competitors?.find(c => c.homeAway === 'away');

        if (homeComp && awayComp) {
          const rawHg = homeComp.score?.value ?? homeComp.score;
          const rawAg = awayComp.score?.value ?? awayComp.score;
          if (isValidScore(rawHg) && isValidScore(rawAg)) {
            homeGoals = Number(rawHg);
            awayGoals = Number(rawAg);
          }

          // Linescores for half-time
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
      // Format 2: Normalized fixture structure
      else if (summary.status && summary.score) {
        matchStatus = classifyMatchStatus(summary.status.state || summary.status);
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

      if (matchStatus === 'finished' && isValidScore(homeGoals) && isValidScore(awayGoals)) {
        for (const doc of group.docs) {
          const res = await settlePrediction(admin, doc, {
            homeGoals,
            awayGoals,
            htHome,
            htAway,
            totalCorners,
          }, 'espn-auto', logger);
          if (res) {
            settledCount++;
            settlementReports.push(res);
          }
        }
      }
    } catch (err) {
      errorCount++;
      if (logger) logger.warn('Failed auto-settling match', { matchId, error: err.message });
    }
  }

  return {
    checked: pendingSnap.size,
    settled: settledCount,
    errors: errorCount,
    results: settlementReports,
  };
}

// ──────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────

module.exports = {
  settleMarket,
  classifyMatchStatus,
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
};
