/**
 * basketball/adjustments.js
 *
 * Bounded, config-capped adjustments applied on top of the base projection, plus
 * the data-quality score that gates whether a pick may be shown at all.
 *
 * Every component is individually capped AND the summed adjustment has an overall
 * ceiling, so no single signal (or combination) can dominate the projection.
 *
 * Sign conventions:
 *   margin = home_points - away_points  (positive favours the home team)
 *   total  = home_points + away_points
 *   A "penalty" is expressed as positive points a team LOSES; it is converted to a
 *   margin shift toward the opponent inside computeAdjustments().
 *
 * Missing inputs contribute nothing (never fabricated), but they DO lower the
 * data-quality score so the selector can demote or suppress the pick.
 */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(dp));
}

function isFiniteNum(v) {
  return v != null && Number.isFinite(v);
}

/**
 * Rest / fatigue penalty for one team, in points lost.
 * Back-to-backs and 3-games-in-4 both hurt the margin; each also trims the total slightly.
 */
function fatiguePenalty(ratings, cfg) {
  const a = cfg.adjustments;
  const caps = a.caps;
  let margin = 0;
  let total = 0;
  const notes = [];

  if (ratings?.backToBack) {
    margin += a.backToBack.margin;
    total += a.backToBack.total;
    notes.push('2nd night of a back-to-back');
  }
  if (ratings?.threeInFour) {
    margin += a.threeInFour.margin;
    total += a.threeInFour.total;
    notes.push('3rd game in 4 nights');
  }

  return {
    margin: clamp(margin, 0, caps.restMargin),
    total: clamp(total, 0, caps.restTotal),
    notes,
  };
}

/**
 * Travel / altitude penalty. Only applied when the context actually supplies the
 * distance or the venue altitude — we never guess.
 *
 * @param {string} side - 'home' | 'away'
 * @param {Object|null} context - { travelKm: {home,away}, altitudeMeters }
 */
function travelPenalty(side, context, cfg) {
  const a = cfg.adjustments;
  const caps = a.caps;
  let margin = 0;
  let total = 0;
  const notes = [];

  const km = context?.travelKm?.[side];
  if (isFiniteNum(km) && km >= a.longTravel.kmThreshold) {
    margin += a.longTravel.margin;
    total += a.longTravel.total;
    notes.push(`long travel (${Math.round(km)} km)`);
  }

  // Altitude favours the home team; applied to the home side only.
  const alt = context?.altitudeMeters;
  if (side === 'home' && isFiniteNum(alt) && alt >= a.altitude.metersThreshold) {
    margin -= a.altitude.margin; // negative penalty == home gains
    total += a.altitude.total;
    notes.push(`altitude venue (${Math.round(alt)} m)`);
  }

  return {
    margin: clamp(margin, -caps.travelMargin, caps.travelMargin),
    total: clamp(total, -caps.travelTotal, caps.travelTotal),
    notes,
  };
}

/**
 * Injury penalty for one team's injury list.
 *
 * Impact per player = base impact x minutes-share scale x unavailability x (1 - replacement share).
 * Availability is probability-weighted (questionable = 0.5, doubtful = 0.25, out = 0).
 * Per-player and combined caps are enforced.
 *
 * @param {Array} list - injuries for one side
 * @returns {Object} { margin, total, details, flags }
 */
function injuryPenalty(list, cfg) {
  const a = cfg.adjustments;
  const caps = a.caps;
  const av = a.availability;
  const rl = clamp(a.replacementLevelShare ?? 0.6, 0, 1);
  const fullShare = a.injuries.fullMinutesShare ?? 0.35;

  let margin = 0;
  let total = 0;
  const details = [];
  const flags = [];

  (Array.isArray(list) ? list : []).forEach(inj => {
    const status = String(inj?.status || '').toLowerCase();
    const availability = Object.prototype.hasOwnProperty.call(av, status) ? av[status] : 1;
    const unavail = clamp(1 - availability, 0, 1);
    if (unavail <= 0) return;

    const share = isFiniteNum(inj?.minutesShare) ? inj.minutesShare
      : isFiniteNum(inj?.usage) ? inj.usage : null;
    const scale = share != null ? clamp(share / fullShare, 0, 1.5) : 1;

    const baseMargin = isFiniteNum(inj?.impactMargin) ? inj.impactMargin : a.injuries.defaultImpactMargin;
    const baseTotal = isFiniteNum(inj?.impactTotal) ? inj.impactTotal : a.injuries.defaultImpactTotal;

    const pMargin = clamp(baseMargin * scale * unavail * (1 - rl), -caps.perPlayerMargin, caps.perPlayerMargin);
    const pTotal = clamp(baseTotal * scale * unavail * (1 - rl), -caps.perPlayerTotal, caps.perPlayerTotal);

    margin += pMargin;
    total += pTotal;

    const name = inj?.playerName || inj?.name || 'Unknown player';
    details.push({
      player: name,
      status: status || 'unknown',
      availability: round(availability, 2),
      margin: round(pMargin, 2),
      total: round(pTotal, 2),
    });
    if (['out', 'doubtful', 'questionable', 'day-to-day'].includes(status)) {
      flags.push(`${name} ${status}`);
    }
  });

  return {
    margin: clamp(margin, -caps.combined, caps.combined),
    total: clamp(total, -caps.combinedTotal ?? caps.combined, caps.combinedTotal ?? caps.combined),
    details,
    flags,
  };
}

/**
 * Pace interaction: two slow teams lower the total more than a plain average
 * suggests (and the projection's pace blend already leans toward the faster team).
 * Applied only on the slow side (deviation < 0), bounded by config.
 *
 * @param {number} avgPace - simple average of the two teams' paces
 * @param {Object} leagueCfg
 * @param {Object} cfg
 */
function paceInteractionTotal(avgPace, leagueCfg, cfg) {
  const lmPace = leagueCfg?.leagueMean?.possessions;
  if (!isFiniteNum(avgPace) || !isFiniteNum(lmPace) || lmPace <= 0) return 0;
  const dev = (avgPace - lmPace) / lmPace;
  if (dev >= 0) return 0;
  // `paceInteraction.total` = points of total change per 10% pace deviation.
  const adj = cfg.adjustments.paceInteraction.total * (dev / 0.10);
  return clamp(adj, -Math.abs(cfg.adjustments.paceInteraction.total), 0);
}

/**
 * Motivation / schedule-spot adjustment. Context must supply explicit signed
 * point values per side; nothing is inferred. Kept small and capped.
 */
function motivationMargin(context, cfg) {
  const a = cfg.adjustments;
  const home = isFiniteNum(context?.motivation?.home) ? context.motivation.home : 0;
  const away = isFiniteNum(context?.motivation?.away) ? context.motivation.away : 0;
  return clamp(home - away, -a.caps.motivationMargin, a.caps.motivationMargin);
}

/**
 * Compute all bounded adjustments for a game.
 *
 * @param {Object} params
 * @param {Object} params.projection    - base projection ({ total, margin, expectedPossessions })
 * @param {Object} params.homeRatings   - computeTeamRatings() output for the home team
 * @param {Object} params.awayRatings   - computeTeamRatings() output for the away team
 * @param {Object} [params.injuries]    - { home: [], away: [] }
 * @param {Object} [params.context]     - { travelKm:{home,away}, altitudeMeters, motivation:{home,away} }
 * @param {Object} params.leagueCfg
 * @param {Object} params.cfg
 * @returns {Object} { margin, total, breakdown, flags }
 */
function computeAdjustments({ projection, homeRatings, awayRatings, injuries = {}, context = null, leagueCfg, cfg }) {
  const a = cfg.adjustments;
  const breakdown = [];
  const flags = [];

  let margin = 0;
  let total = 0;

  // --- Rest / fatigue (margin mainly, smaller total) ---
  const homeFatigue = fatiguePenalty(homeRatings, cfg);
  const awayFatigue = fatiguePenalty(awayRatings, cfg);
  if (homeFatigue.margin || homeFatigue.total) {
    breakdown.push({ type: 'fatigue', team: 'home', margin: round(-homeFatigue.margin, 2), total: round(-homeFatigue.total, 2), notes: homeFatigue.notes });
    flags.push(...homeFatigue.notes.map(n => `Home: ${n}`));
  }
  if (awayFatigue.margin || awayFatigue.total) {
    breakdown.push({ type: 'fatigue', team: 'away', margin: round(awayFatigue.margin, 2), total: round(-awayFatigue.total, 2), notes: awayFatigue.notes });
    flags.push(...awayFatigue.notes.map(n => `Away: ${n}`));
  }
  margin += awayFatigue.margin - homeFatigue.margin;
  total -= homeFatigue.total + awayFatigue.total;

  // --- Travel / altitude (only when known) ---
  const homeTravel = travelPenalty('home', context, cfg);
  const awayTravel = travelPenalty('away', context, cfg);
  if (homeTravel.margin || homeTravel.total) {
    breakdown.push({ type: 'travel', team: 'home', margin: round(-homeTravel.margin, 2), total: round(homeTravel.total, 2), notes: homeTravel.notes });
  }
  if (awayTravel.margin || awayTravel.total) {
    breakdown.push({ type: 'travel', team: 'away', margin: round(awayTravel.margin, 2), total: round(awayTravel.total, 2), notes: awayTravel.notes });
  }
  margin += awayTravel.margin - homeTravel.margin;
  total += homeTravel.total + awayTravel.total;

  // --- Injuries (probability-weighted, capped per player and combined) ---
  const homeInj = injuryPenalty(injuries?.home, cfg);
  const awayInj = injuryPenalty(injuries?.away, cfg);
  if (homeInj.margin || homeInj.total) {
    breakdown.push({ type: 'injuries', team: 'home', margin: round(-homeInj.margin, 2), total: round(-homeInj.total, 2), details: homeInj.details });
  }
  if (awayInj.margin || awayInj.total) {
    breakdown.push({ type: 'injuries', team: 'away', margin: round(awayInj.margin, 2), total: round(-awayInj.total, 2), details: awayInj.details });
  }
  margin += awayInj.margin - homeInj.margin;
  total -= homeInj.total + awayInj.total;
  flags.push(...homeInj.flags.map(f => `Home: ${f}`), ...awayInj.flags.map(f => `Away: ${f}`));

  // --- Pace interaction (slow games shrink the total further) ---
  const homePace = homeRatings?.pace;
  const awayPace = awayRatings?.pace;
  if (isFiniteNum(homePace) && isFiniteNum(awayPace)) {
    const paceAdj = paceInteractionTotal((homePace + awayPace) / 2, leagueCfg, cfg);
    if (paceAdj) {
      breakdown.push({ type: 'paceInteraction', team: 'both', margin: 0, total: round(paceAdj, 2), notes: ['both teams slower than league average'] });
      total += paceAdj;
    }
  }

  // --- Motivation (explicit context only) ---
  const mot = motivationMargin(context, cfg);
  if (mot) {
    breakdown.push({ type: 'motivation', team: 'home', margin: round(mot, 2), total: 0, notes: ['schedule-spot motivation'] });
    margin += mot;
  }

  // --- Overall ceilings ---
  margin = clamp(margin, -a.caps.marginOverall, a.caps.marginOverall);
  total = clamp(total, -a.caps.totalOverall, a.caps.totalOverall);

  return {
    margin: round(margin, 2),
    total: round(total, 2),
    breakdown,
    flags,
  };
}

/**
 * Apply adjustments to a base projection.
 * @returns {Object} adjusted projection
 */
function applyAdjustments(projection, adj) {
  if (!projection) return null;
  return {
    ...projection,
    total: round((projection.total ?? 0) + (adj?.total ?? 0), 2),
    margin: round((projection.margin ?? 0) + (adj?.margin ?? 0), 2),
    baseTotal: projection.total,
    baseMargin: projection.margin,
    adjustments: adj || { margin: 0, total: 0, breakdown: [], flags: [] },
  };
}

/** Coverage (0..1) of core metrics required for a trustworthy projection. */
function coverageScore(ratings, form) {
  const core = [
    ratings?.ortg, ratings?.drtg, ratings?.pace,
    form?.season?.avgTotal, form?.season?.ortg, form?.season?.efgPct,
  ];
  const present = core.filter(isFiniteNum).length;
  return present / core.length;
}

/**
 * Data-quality score (0..1) from sample size, field coverage, missing odds and
 * unresolved injury statuses. Lower scores demote or suppress picks.
 *
 * @returns {Object} { score, penalties }
 */
function computeDataQuality({ homeRatings, awayRatings, homeForm, awayForm, injuries, odds, lineups, leagueCfg, cfg }) {
  const dqc = cfg.dataQuality;
  const penalties = [];

  const minGames = dqc.minGamesPerTeam ?? 5;
  // A team we only know from its prior-season baseline is a REAL input, just at a
  // reduced weight — so an early-season game carries a much smaller penalty than
  // one whose ratings fell back to the league mean.
  const priorWeight = dqc.priorSmallSamplePenalty ?? 0.1;
  [['home', homeRatings], ['away', awayRatings]].forEach(([side, r]) => {
    const g = r?.gamesPlayed ?? 0;
    if (g < minGames) {
      const weight = r?.realPrior ? priorWeight : 0.3;
      penalties.push({
        reason: r?.realPrior
          ? `${side} early season (${g}/${minGames} games, prior-season baseline)`
          : `${side} small sample (${g}/${minGames} games)`,
        value: ((minGames - g) / minGames) * weight,
      });
    }
  });

  const avgCov = (coverageScore(homeRatings, homeForm) + coverageScore(awayRatings, awayForm)) / 2;
  if (avgCov < 1) {
    penalties.push({ reason: `missing stat fields (coverage ${round(avgCov, 2)})`, value: (1 - avgCov) * 0.25 });
  }

  if (!odds) {
    penalties.push({ reason: 'no bookmaker odds', value: dqc.noOddsPenalty ?? 0.1 });
  }

  const list = [...(injuries?.home || []), ...(injuries?.away || [])];
  const unresolved = list.filter(i => ['questionable', 'doubtful', 'day-to-day'].includes(String(i?.status || '').toLowerCase())).length;
  if (unresolved > 0) {
    penalties.push({ reason: `${unresolved} unresolved player status(es)`, value: Math.min(0.2, unresolved * (dqc.questionablePlayerPenalty ?? 0.05)) });
  }

  if (lineups && lineups.home && lineups.away && lineups.home.confirmed && lineups.away.confirmed) {
    // Confirmed lineups are rare with ESPN's summary; when present they help.
    penalties.push({ reason: 'confirmed lineups', value: -(dqc.confirmedLineupsBonus ?? 0.05) });
  }

  const totalPenalty = penalties.reduce((s, p) => s + p.value, 0);
  const score = clamp(1 - totalPenalty, 0, 1);

  return { score: round(score, 3), penalties };
}

module.exports = {
  clamp,
  round,
  fatiguePenalty,
  travelPenalty,
  injuryPenalty,
  paceInteractionTotal,
  motivationMargin,
  computeAdjustments,
  applyAdjustments,
  coverageScore,
  computeDataQuality,
};
