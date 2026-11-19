'use strict';

/**
 * footballMarkets.js — Poisson-based football market engine.
 *
 * Prices pre-match football markets from team goal/corner/card averages
 * (the same underlying stats the historical engines consume) and derives
 * match-result probabilities via a Poisson score-matrix model.
 *
 * The engine is a *selection* engine: it evaluates every supported market
 * and emits only the strongest statistically justified candidates.
 * Straight Home Win / Draw / Away Win are never emitted as recommendations —
 * only Double Chance (1X / X2 / 12).
 */

// ---------- math helpers ----------

function poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) term *= lambda / i;
  return term;
}

// P(X <= k) for Poisson(lambda)
function poissonCdfLE(lambda, k) {
  let sum = 0;
  for (let i = 0; i <= k; i += 1) sum += poissonPmf(lambda, i);
  return sum;
}

/** 3x3 Poisson score matrix → { home, draw, away, matrix }. */
function outcomeMatrix(homeLambda, awayLambda, maxGoals = 8) {
  const home = [];
  const away = [];
  const matrix = [];
  for (let h = 0; h <= maxGoals; h += 1) {
    home[h] = poissonPmf(homeLambda, h);
    away[h] = poissonPmf(awayLambda, h);
  }
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let i = 0; i <= maxGoals; i += 1) {
    for (let j = 0; j <= maxGoals; j += 1) {
      const p = home[i] * away[j];
      matrix[i] = matrix[i] || [];
      matrix[i][j] = p;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
    }
  }
  const total = pHome + pDraw + pAway;
  return { home: pHome / total, draw: pDraw / total, away: pAway / total, matrix };
}

/** Distribution of total goals 0..maxT via convolution of two Poisson lambdas. */
function totalGoalsDist(lh, la, maxT = 12) {
  const dist = new Array(maxT + 1).fill(0);
  for (let t = 0; t <= maxT; t += 1) {
    let sum = 0;
    for (let h = Math.max(0, t - maxT); h <= Math.min(t, 10); h += 1) {
      const a = t - h;
      if (a > 10) continue;
      sum += poissonPmf(lh, h) * poissonPmf(la, a);
    }
    dist[t] = sum;
  }
  return dist;
}

// ---------- market catalog ----------

// Full-time goal lines: [key, line, direction]
const FT_GOAL_LINES = [
  ['over_0_5_goals', 0.5, 'over'], ['under_1_5_goals', 1.5, 'under'],
  ['over_1_5_goals', 1.5, 'over'], ['over_2_5_goals', 2.5, 'over'],
  ['under_2_5_goals', 2.5, 'under'], ['over_3_5_goals', 3.5, 'over'],
  ['under_3_5_goals', 3.5, 'under'], ['under_4_5_goals', 4.5, 'under'],
  ['over_4_5_goals', 4.5, 'over'], ['under_0_5_goals', 0.5, 'under'],
];

const HT_GOAL_LINES = [
  ['over_0_5_ht', 0.5, 'over'], ['under_0_5_ht', 0.5, 'under'],
  ['over_1_5_ht', 1.5, 'over'], ['under_1_5_ht', 1.5, 'under'],
];

const H2_GOAL_LINES = [
  ['over_0_5_2h', 0.5, 'over'], ['under_0_5_2h', 0.5, 'under'],
  ['over_1_5_2h', 1.5, 'over'], ['under_1_5_2h', 1.5, 'under'],
];

const TEAM_GOAL_LINES = [
  ['over_0_5', 0.5, 'over'], ['under_1_5', 1.5, 'under'],
  ['under_2_5', 2.5, 'under'], ['under_0_5', 0.5, 'under'],
];

const CORNER_LINES_TOTAL = [4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5];
const CORNER_LINES_TEAM = [2.5, 3.5, 5.5];
const CARD_LINES_TOTAL = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

const clamp01 = (p) => Math.max(0, Math.min(1, p));
const round4 = (p) => Math.round(clamp01(p) * 10000) / 10000;

/** Estimate half-time share of total goals from match history (default 0.40). */
function estimateHtRatio(homeMatches, awayMatches) {
  let ht = 0;
  let ft = 0;
  const scan = (m) => {
    if (!m || typeof m !== 'object') return;
    const total = m.totalGoals != null ? Number(m.totalGoals) : null;
    const htTotal = m.htScore && m.htScore.total != null ? Number(m.htScore.total) : null;
    if (total != null && htTotal != null && !isNaN(total) && !isNaN(htTotal) && total > 0) {
      ft += total;
      ht += htTotal;
    }
  };
  (homeMatches || []).forEach(scan);
  (awayMatches || []).forEach(scan);
  if (ft >= 8) return ht / ft;
  return 0.40;
}

/** Mean of a stat across both teams' matches; returns {mean, samples} or null. */
function statMean(matches, pick, minSamples = 4) {
  let sum = 0;
  let n = 0;
  const seen = new Set();
  for (const list of [matches.homeMatches, matches.awayMatches]) {
    for (const m of list || []) {
      const v = pick(m);
      if (v != null && !isNaN(v) && !seen.has(m)) {
        seen.add(m);
        sum += Number(v);
        n += 1;
      }
    }
  }
  if (n < minSamples) return null;
  return { mean: sum / n, samples: n };
}

function cornerFor(m, team) {
  // match objects carry 'corners' (team) + 'cornersConceded' (opponent)
  if (!m) return null;
  const c = m.corners != null ? Number(m.corners) : null;
  const cc = m.cornersConceded != null ? Number(m.cornersConceded) : null;
  return { for: c, against: cc };
}

function bookingsFor(m) {
  if (!m) return null;
  if (m.totalBookings != null && !isNaN(m.totalBookings)) return Number(m.totalBookings);
  const y = m.yellowCards != null ? Number(m.yellowCards) : 0;
  const ry = m.opponentYellowCards != null ? Number(m.opponentYellowCards) : 0;
  const r = m.redCards != null ? Number(m.redCards) : 0;
  const rr = m.opponentRedCards != null ? Number(m.opponentRedCards) : 0;
  if (y || ry || r || rr) return y + ry + r + rr;
  return null;
}

/**
 * Build the full pre-match market evaluation.
 *
 * @param {object} input
 *   homeExpected, awayExpected  — expected goals (lambda) per side
 *   homeMatches, awayMatches    — recent match arrays (for htRatio/corners/cards)
 *   totalCornersAvg             — optional explicit average total corners
 *   totalBookingsAvg            — optional explicit average total bookings/cards
 *   homeCornersAvg/awayCornersAvg/homeBookingsAvg/awayBookingsAvg — optional team splits
 *   shotsEvaluation             — optional array of pre-priced shot market candidates
 *   homeName, awayName          — for labels
 * @returns {Array} candidate markets
 */
function buildPreMatchMarkets(input = {}) {
  const candidates = [];
  const lh = Number(input.homeExpected);
  const la = Number(input.awayExpected);
  const totalLambda = (isNaN(lh) ? 0 : lh) + (isNaN(la) ? 0 : la);
  const validGoals = !isNaN(lh) && !isNaN(la) && lh >= 0 && la >= 0;

  const add = (c) => candidates.push(c);
  const mk = (over, fields = {}) => add({
    status: 'available',
    dataQuality: fields.quality || 'medium',
    explanation: fields.explanation || '',
    ...over,
  });

  if (validGoals) {
    // --- match outcome → Double Chance ---
    const oc = outcomeMatrix(lh, la);
    const dc = [
      ['double_chance', '1X', oc.home + oc.draw, 'Double Chance 1X'],
      ['double_chance', 'X2', oc.away + oc.draw, 'Double Chance X2'],
      ['double_chance', '12', oc.home + oc.away, 'Double Chance 12'],
    ];
    for (const [family, selection, prob, label] of dc) {
      mk({
        category: 'double_chance', family, market: 'double_chance',
        line: null, selection, label, value: label,
        probability: round4(prob),
        model: 'poisson_matrix',
        dataQuality: 'high',
        explanation: `P(${selection}) derived from Poisson score matrix (xG ${lh.toFixed(2)} vs ${la.toFixed(2)}).`,
      });
    }

    // --- full-time goal lines ---
    const ftDist = totalGoalsDist(lh, la);
    for (const [key, line, dir] of FT_GOAL_LINES) {
      // P(total goals > line) for over; P(total <= line) for under
      const over = ftDist.slice(Math.floor(line) + 1).reduce((s, p) => s + p, 0);
      // careful: line is x.5 so over = P(total >= ceil(line)) = P(total > line)
      const overProb = ftDist.slice(Math.floor(line) + 1).reduce((s, p) => s + p, 0);
      const prob = dir === 'over' ? overProb : 1 - overProb;
      mk({
        category: 'goals', family: 'goals_ft', market: key,
        line, selection: dir, label: `${dir === 'over' ? 'Over' : 'Under'} ${line} Goals`,
        value: `${dir === 'over' ? 'Over' : 'Under'} ${line}`,
        probability: round4(prob), model: 'poisson_total',
        explanation: `Total-goals Poisson (λ=${totalLambda.toFixed(2)}).`,
      });
    }

    // --- first-half goals ---
    const htRatio = estimateHtRatio(input.homeMatches, input.awayMatches);
    const lhHt = lh * htRatio;
    const laHt = la * htRatio;
    const htDist = totalGoalsDist(lhHt, laHt);
    for (const [key, line, dir] of HT_GOAL_LINES) {
      const overProb = htDist.slice(Math.floor(line) + 1).reduce((s, p) => s + p, 0);
      const prob = dir === 'over' ? overProb : 1 - overProb;
      mk({
        category: 'first_half', family: 'goals_ht', market: key,
        line, selection: dir, label: `${dir === 'over' ? 'Over' : 'Under'} ${line} HT Goals`,
        value: `${dir === 'over' ? 'Over' : 'Under'} ${line} HT`,
        probability: round4(prob), model: 'poisson_ht',
        explanation: `First-half goals ≈ ${(totalLambda * htRatio).toFixed(2)} (HT share ${(htRatio * 100).toFixed(0)}%).`,
      });
    }

    // --- second-half goals ---
    const lh2h = lh * (1 - htRatio);
    const la2h = la * (1 - htRatio);
    const h2Dist = totalGoalsDist(lh2h, la2h);
    for (const [key, line, dir] of H2_GOAL_LINES) {
      const overProb = h2Dist.slice(Math.floor(line) + 1).reduce((s, p) => s + p, 0);
      const prob = dir === 'over' ? overProb : 1 - overProb;
      mk({
        category: 'second_half', family: 'goals_2h', market: key,
        line, selection: dir, label: `${dir === 'over' ? 'Over' : 'Under'} ${line} 2H Goals`,
        value: `${dir === 'over' ? 'Over' : 'Under'} ${line} 2H`,
        probability: round4(prob), model: 'poisson_2h',
        explanation: `Second-half goals ≈ ${(totalLambda * (1 - htRatio)).toFixed(2)}.`,
      });
    }

    // --- team goal markets ---
    const teams = [
      ['home', lh, input.homeName],
      ['away', la, input.awayName],
    ];
    for (const [side, lambda, name] of teams) {
      const nameStr = name || (side === 'home' ? 'Home' : 'Away');
      for (const [suffix, line, dir] of TEAM_GOAL_LINES) {
        const p0 = poissonPmf(lambda, 0);
        const p1 = poissonPmf(lambda, 1);
        const p2 = poissonPmf(lambda, 2);
        let prob;
        if (dir === 'over' && line === 0.5) prob = 1 - p0;              // team scores at least once
        else if (dir === 'under' && line === 1.5) prob = p0 + p1;       // 0 or 1 goal
        else if (dir === 'under' && line === 2.5) prob = p0 + p1 + p2;  // 0,1,2 goals
        else if (dir === 'under' && line === 0.5) prob = p0;            // fails to score
        else prob = dir === 'over' ? 1 - poissonCdfLE(lambda, Math.floor(line)) : poissonCdfLE(lambda, Math.floor(line));
        const marketKey = `${side}_${suffix}_goals`;
        mk({
          category: 'team_goals', family: `team_goals_${side}`, market: marketKey,
          line, selection: dir, label: `${nameStr} ${dir === 'over' ? 'Over' : 'Under'} ${line} Goals`,
          value: `${nameStr} ${dir === 'over' ? 'Over' : 'Under'} ${line}`,
          probability: round4(prob), model: 'poisson_team',
          explanation: `${nameStr} expected goals λ=${lambda.toFixed(2)}.`,
        });
      }
    }

    // --- BTTS ---
    const pHomeScores = 1 - poissonPmf(lh, 0);
    const pAwayScores = 1 - poissonPmf(la, 0);
    const bttsYes = round4(pHomeScores * pAwayScores);
    mk({
      category: 'btts', family: 'btts', market: 'btts', line: null,
      selection: 'yes', label: 'BTTS Yes', value: 'BTTS - Yes',
      probability: bttsYes, model: 'poisson_btts',
      explanation: 'P(both score) ≈ P(home scores) × P(away scores).',
    });
    mk({
      category: 'btts', family: 'btts', market: 'btts', line: null,
      selection: 'no', label: 'BTTS No', value: 'BTTS - No',
      probability: round4(1 - bttsYes), model: 'poisson_btts',
      explanation: 'P(at least one side fails to score).',
    });

    // --- half-time result markets ---
    const htOc = outcomeMatrix(lhHt, laHt, 6);
    const htDc = [
      ['ht_double_chance', '1X', htOc.home + htOc.draw, 'HT Double Chance 1X'],
      ['ht_double_chance', 'X2', htOc.away + htOc.draw, 'HT Double Chance X2'],
    ];
    for (const [family, selection, prob, label] of htDc) {
      mk({
        category: 'first_half', family: 'ht_result', market: family,
        line: null, selection, label, value: label,
        probability: round4(prob), model: 'poisson_ht_matrix',
        explanation: `Half-time outcome from Poisson matrix (HT λ ${lhHt.toFixed(2)} vs ${laHt.toFixed(2)}).`,
      });
    }
    mk({
      category: 'first_half', family: 'ht_result', market: 'ht_draw',
      line: null, selection: 'draw', label: 'Half-Time Draw', value: 'HT Draw',
      probability: round4(htOc.draw), model: 'poisson_ht_matrix',
      explanation: `P(HT draw) from half-time Poisson matrix.`,
    });
  }

  // --- corners ---
  const homeC = statMean({ homeMatches: input.homeMatches, awayMatches: [] }, cornerFor, 4);
  const awayC = statMean({ homeMatches: [], awayMatches: input.awayMatches }, (m) => cornerFor(m, 'away'), 4);
  const cornerData = input.totalCornersAvg != null
    ? { mean: Number(input.totalCornersAvg), samples: 99, source: 'explicit' }
    : statMean({ homeMatches: input.homeMatches, awayMatches: input.awayMatches }, (m) => {
        const c = cornerFor(m);
        return c && c.for != null && c.against != null ? c.for + c.against : null;
      }, 4);

  // expected total corners: prefer explicit avg, else sum of team corner-for means, else match total mean
  let cornersLambda = null;
  let cornersQuality = 'low';
  let cornersSamples = 0;
  if (cornerData) { cornersLambda = cornerData.mean; cornersQuality = cornerData.samples >= 8 ? 'high' : 'medium'; cornersSamples = cornerData.samples; }
  if (homeC && awayC) {
    const teamSum = homeC.mean + awayC.mean;
    if (cornersLambda == null || Math.abs(teamSum - cornersLambda) > 4) {
      cornersLambda = teamSum;
      cornersQuality = (homeC.mean && homeC.samples >= 4 ? 'medium' : cornersQuality);
    }
  }
  if (cornersLambda != null && cornersLambda > 0) {
    const cDistMax = 20;
    const cDist = new Array(cDistMax + 1).fill(0);
    for (let k = 0; k <= cDistMax; k += 1) cDist[k] = poissonPmf(cornersLambda, k);
    for (const line of CORNER_LINES_TOTAL) {
      const overProb = 1 - poissonCdfLE(cornersLambda, Math.floor(line));
      for (const dir of ['over', 'under']) {
        const prob = dir === 'over' ? overProb : 1 - overProb;
        // emit only the side that could plausibly clear threshold? emit both; selection filters
        if (prob < 0.02 || prob > 0.98) continue;
        mk({
          category: 'corners', family: 'corners_total', market: `corners_${dir}_${String(line).replace('.', '_')}`,
          line, selection: dir, label: `${dir === 'over' ? 'Over' : 'Under'} ${line} Corners`,
          value: `${dir === 'over' ? 'Over' : 'Under'} ${line} Corners`,
          probability: round4(prob), model: 'poisson_corners',
          dataQuality: cornersQuality,
          explanation: `Expected total corners λ=${cornersLambda.toFixed(1)} (${cornersSamples} matches).`,
        });
      }
    }
    // team corners
    for (const [side, stat] of [['home', homeC], ['away', awayC]]) {
      if (!stat) continue;
      const lam = stat.mean;
      for (const line of CORNER_LINES_TEAM) {
        const overProb = 1 - poissonCdfLE(lam, Math.floor(line));
        for (const dir of ['over', 'under']) {
          const prob = dir === 'over' ? overProb : 1 - overProb;
          if (prob < 0.02 || prob > 0.98) continue;
          mk({
            category: 'corners', family: `corners_${side}`, market: `${side}_corners_${dir}_${String(line).replace('.', '_')}`,
            line, selection: dir, label: `${side === 'home' ? 'Home' : 'Away'} Team ${dir === 'over' ? 'Over' : 'Under'} ${line} Corners`,
            value: `${side === 'home' ? 'Home' : 'Away'} ${dir === 'over' ? 'Over' : 'Under'} ${line}`,
            probability: round4(prob), model: 'poisson_corners_team',
            dataQuality: stat.samples >= 8 ? 'high' : 'medium',
            explanation: `${side === 'home' ? 'Home' : 'Away'} expected corners λ=${lam.toFixed(1)} (${stat.samples} matches).`,
          });
        }
      }
    }
  }

  // --- cards / bookings ---
  const cardData = input.totalBookingsAvg != null
    ? { mean: Number(input.totalBookingsAvg), samples: 99 }
    : statMean({ homeMatches: input.homeMatches, awayMatches: input.awayMatches }, bookingsFor, 4);
  let cardsLambda = cardData ? cardData.mean : null;
  const cardsQuality = cardData ? (cardData.samples >= 8 ? 'high' : 'medium') : 'low';
  if (cardsLambda != null && cardsLambda > 0) {
    for (const line of CARD_LINES_TOTAL) {
      const overProb = 1 - poissonCdfLE(cardsLambda, Math.floor(line));
      for (const dir of ['over', 'under']) {
        const prob = dir === 'over' ? overProb : 1 - overProb;
        if (prob < 0.02 || prob > 0.98) continue;
        mk({
          category: 'cards', family: 'cards_total', market: `cards_${dir}_${String(line).replace('.', '_')}`,
          line, selection: dir, label: `${dir === 'over' ? 'Over' : 'Under'} ${line} Cards`,
          value: `${dir === 'over' ? 'Over' : 'Under'} ${line} Cards`,
          probability: round4(prob), model: 'poisson_cards',
          dataQuality: cardsQuality,
          explanation: `Expected total cards/bookings λ=${cardsLambda.toFixed(1)} (${cardData.samples} matches).`,
        });
      }
    }
    // team cards (home/away bookings split from per-match fields when available)
    for (const side of ['home', 'away']) {
      const stat = statMean({ homeMatches: side === 'home' ? input.homeMatches : [], awayMatches: side === 'away' ? input.awayMatches : [] }, (m) => {
        if (!m) return null;
        const mine = side === 'home'
          ? (m.yellowCards != null || m.redCards != null ? (Number(m.yellowCards || 0) + Number(m.redCards || 0)) : null)
          : (m.opponentYellowCards != null || m.opponentRedCards != null ? (Number(m.opponentYellowCards || 0) + Number(m.opponentRedCards || 0)) : null);
        return mine;
      }, 4);
      if (!stat) continue;
      const overProb = 1 - poissonPmf(stat.mean, 0); // P(team gets >=1 card)
      for (const dir of ['over', 'under']) {
        const prob = dir === 'over' ? overProb : 1 - overProb;
        if (prob < 0.02 || prob > 0.98) continue;
        mk({
          category: 'cards', family: `cards_${side}`, market: `${side}_cards_${dir}_0_5`,
          line: 0.5, selection: dir, label: `${side === 'home' ? 'Home' : 'Away'} Team ${dir === 'over' ? 'Over' : 'Under'} 0.5 Cards`,
          value: `${side === 'home' ? 'Home' : 'Away'} ${dir === 'over' ? 'Over' : 'Under'} 0.5`,
          probability: round4(prob), model: 'poisson_cards_team',
          dataQuality: stat.samples >= 8 ? 'high' : 'medium',
          explanation: `${side === 'home' ? 'Home' : 'Away'} expected cards λ=${stat.mean.toFixed(1)} (${stat.samples} matches).`,
        });
      }
    }
  }

  // --- shots (only when pre-priced candidates supplied) ---
  for (const s of input.shotsEvaluation || []) {
    if (s && s.market) {
      mk({
        category: 'shots', family: s.family || 'shots', market: s.market,
        line: s.line != null ? s.line : null, selection: s.selection,
        label: s.label || s.market, value: s.value || s.label || s.market,
        probability: typeof s.probability === 'number' ? s.probability : (s.confidence != null ? s.confidence / 100 : null),
        model: s.model || 'shots_engine',
        dataQuality: s.dataQuality || 'medium',
        explanation: s.explanation || '',
      });
    }
  }

  return candidates;
}

// ---------- selection engine ----------

/**
 * Select the strongest justified markets.
 * - Drops non-available, sub-threshold, or missing-probability candidates.
 * - De-duplicates within each market family (mutually exclusive options like
 *   the three Double Chance selections compete; only the best survives).
 * - Caps picks per family and overall.
 *
 * @param {Array} candidates
 * @param {object} opts { threshold=0.90, maxPicks=4, maxPerFamily }
 */
function selectFootballMarkets(candidates, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.90;
  const maxPicks = opts.maxPicks != null ? opts.maxPicks : 4;
  const maxPerFamily = opts.maxPerFamily || {
    result: 1, double_chance: 1, goals_ft: 2, goals_ht: 1, goals_2h: 1,
    team_goals_home: 1, team_goals_away: 1, team_goals: 2, btts: 1,
    ht_result: 1, corners_total: 1, corners_home: 1, corners_away: 1,
    corners: 2, cards_total: 1, cards_home: 1, cards_away: 1, cards: 2,
    shots: 1, shots_total: 1, shots_home: 1, shots_away: 1,
    team_shots: 1, team_corners: 1,
  };

  const eligible = (candidates || []).filter((c) =>
    c && c.status !== 'lost' && c.status !== 'won' && c.status !== 'unavailable' &&
    typeof c.probability === 'number' && !isNaN(c.probability) &&
    c.probability >= threshold
  );

  // group by family, keep best per family slot
  const byFamily = new Map();
  for (const c of eligible) {
    const fam = c.family || c.market || 'other';
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(c);
  }

  const chosen = [];
  const familyCount = new Map();
  // rank all eligible by probability desc, then dataQuality, then key for determinism
  const qualityRank = { high: 0, medium: 1, low: 2 };
  const sorted = eligible.slice().sort((a, b) =>
    (b.probability - a.probability) ||
    ((qualityRank[a.dataQuality] ?? 3) - (qualityRank[b.dataQuality] ?? 3)) ||
    String(a.market).localeCompare(String(b.market))
  );

  for (const c of sorted) {
    if (chosen.length >= maxPicks) break;
    const fam = c.family || c.market || 'other';
    const cap = maxPerFamily[fam] != null ? maxPerFamily[fam] : (maxPerFamily[c.category] != null ? maxPerFamily[c.category] : 1);
    const used = familyCount.get(fam) || 0;
    if (used >= cap) continue;
    // within same family+market, only one selection direction (dedupe exact market+line)
    const dup = chosen.some((x) => x.market === c.market && x.line === c.line);
    if (dup) continue;
    chosen.push(c);
    familyCount.set(fam, used + 1);
  }
  return chosen;
}

module.exports = {
  buildPreMatchMarkets,
  selectFootballMarkets,
  outcomeMatrix,
  totalGoalsDist,
  estimateHtRatio,
  poissonPmf,
  poissonCdfLE,
};
