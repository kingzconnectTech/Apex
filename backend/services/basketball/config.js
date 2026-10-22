/**
 * basketball/config.js
 *
 * Every tunable of the calibrated basketball engine lives here. Nothing in the
 * pipeline hardcodes a threshold, cap, half-life or sigma value.
 *
 * Per-league values live in leagues.js; this file holds league-agnostic
 * defaults and the selection/calibration policy.
 */

const CONFIG = {
  modelVersion: 'bb-1.0.0',

  // --- Team ratings ---
  ratings: {
    // Exponential recency decay half-life, in games. Default 8-10 games.
    halfLifeGames: 9,
    // Empirical-Bayes shrinkage constant for team ratings (pseudo-games).
    shrinkageM: 6,
    // Extra shrinkage applied to home/away splits (they are noisier than overall).
    splitShrinkageM: 4,
    // Games played at which the current season fully replaces the prior-season prior.
    priorBlendFullWeightGames: 20,
    // Iterative opponent adjustment (SRS).
    srsIterations: 12,
    srsRidge: 0.15,
    // Optional Elo second signal for the margin.
    elo: {
      enabled: true,
      k: 20,
      // Margin-of-victory multiplier cap (Elo MOV dampening).
      movCap: 20,
      // Elo points equivalent to one point of margin (used to convert Elo diff -> points).
      pointsPerElo: 28,
      // Weight given to the Elo margin when blended with the ratings margin.
      blendWeight: 0.25,
    },
  },

  // --- Game projection ---
  projection: {
    // >0.5 leans the blended pace toward the faster team; 0.5 = plain average.
    // Calibrated from backtests rather than assumed.
    paceBlendWeight: 0.55,
  },

  // --- Bounded adjustments (each capped; see caps) ---
  adjustments: {
    // Rest / fatigue (applied mainly to margin, smaller effect on total).
    backToBack: { margin: 2.5, total: 1.0 },
    threeInFour: { margin: 1.5, total: 0.5 },
    // Long travel and altitude are only applied when known.
    longTravel: { margin: 1.5, total: 0.5, kmThreshold: 1500 },
    altitude: { margin: 1.0, total: 0.5, metersThreshold: 1500 },
    // Motivation / schedule spots kept small and bounded.
    motivation: { margin: 1.5, total: 0.5 },
    // Pace interaction: two slow teams lower the total more than the plain average suggests.
    paceInteraction: { total: 3.0 },
    // Blowout / garbage-time down-weighting for historical games.
    blowout: { marginDiff: 20, downWeight: 0.5 },
    // Injury model. ESPN's summary gives us no on/off data, so when a player's
    // minutes share is unknown we fall back to a default per-player impact.
    injuries: {
      defaultImpactMargin: 1.5,
      defaultImpactTotal: 1.0,
      // Minutes share at which a player is treated as a full-weight rotation piece.
      fullMinutesShare: 0.35,
    },
    // Caps.
    caps: {
      perPlayerMargin: 5,
      perPlayerTotal: 4,
      combined: 8,
      combinedTotal: 6,
      restMargin: 4,
      restTotal: 2,
      travelMargin: 2,
      travelTotal: 1,
      motivationMargin: 2,
      motivationTotal: 1,
      // Hard ceilings on the summed adjustment, regardless of component.
      marginOverall: 12,
      totalOverall: 10,
    },
    // Availability probability mapping for questionable/doubtful players.
    availability: {
      out: 0.0,
      doubtful: 0.25,
      questionable: 0.5,
      probable: 0.9,
      'day-to-day': 0.5,
    },
    // Replacement-level share of a rotation player's impact, used when no on/off data exists.
    replacementLevelShare: 0.6,
  },

  // --- Probability model (sigma) ---
  sigma: {
    // Residual distribution: 'normal' or 't' (heavier tails). Chosen by backtest.
    distribution: 'normal',
    // Degrees of freedom when distribution === 't'.
    tDf: 6,
    // League base sigmas live in leagues.js; these are modifiers.
    minTotal: 12,
    maxTotal: 26,
    minMargin: 8,
    maxMargin: 18,
    // Additional sigma (points) per point of projected total away from the league mean.
    totalSizeCoef: 0.02,
    // Additional sigma (points) per possession away from league baseline pace.
    paceCoef: 0.06,
    // NOTE: there is deliberately no data-quality term here. Sigma measures how
    // far the actual score can land from the projection; data quality measures
    // how well-founded the projection is. Coupling them conflated a genuinely
    // uncertain game with a poorly-observed one and dragged every probability
    // toward 50%. Data quality now only drives the confidence tier.
  },

  // --- Calibration ---
  calibration: {
    enabled: true,
    method: 'isotonic', // 'isotonic' | 'platt'
    // Minimum out-of-sample samples required before a calibrator is fitted/trusted.
    minSamples: 150,
    // Minimum GRADED holdout rows before the validation gate may return a verdict.
    // Below this the fit is neither accepted nor rejected — it is simply unjudged.
    minHoldout: 150,
    // Minimum improvement over the identity (raw probability) required on the
    // holdout for a calibrator to be accepted. A fit that merely edges ahead by
    // noise is rejected: both metrics must clear the margin on their own.
    minImprovementBrier: 0.002,
    minImprovementLogLoss: 0.002,
    // Reject any fitted curve that is not monotone non-decreasing in the raw
    // probability (an isotonic fit can only be non-monotone from a bug; a Platt
    // curve is monotone only while its slope `a` stays positive).
    requireMonotone: true,
    // Probability clamp so we never emit 0 or 1.
    epsilon: 0.001,
  },

  // --- Line & pick selection ---
  selection: {
    // These gates are REAL (they are evaluated per candidate in
    // lineSelector.evaluateTwoWayMarket and reported as passes/failReasons), but
    // the values are deliberately permissive: the product policy is to publish
    // every evaluated line with an honest label instead of hiding low-signal
    // ones. Raising any of them starts suppressing picks — the machinery is
    // already in place, only the numbers below would change.
    mainMinProb: 0.0,  // No threshold - show all picks
    alternateMinProb: 0.0,  // No threshold - show all picks
    minEdge: 0.0,  // No edge threshold - show all picks
    minDataQuality: 0.0,  // No data quality threshold - show all picks
    // score = rankProbWeight * prob + rankEvWeight * edgeScaledEv
    rankProbWeight: 0.7,  // Prioritize probability over edge for basketball
    rankEvWeight: 0.3,
    // edgeScaledEv = clamp(ev / evScale, 0, 1)
    evScale: 0.10,
    // Confidence tiers are derived from the pick's own probability AND the data
    // quality behind it — never from probability alone, and never padded to
    // reach a tier. A 62% read off a verified sample and a 62% read off a guess
    // must not carry the same label, so both bars must be cleared.
    confidence: {
      highProb: 0.62,
      mediumProb: 0.55,
      // Data quality required alongside the probability bar above.
      highDataQuality: 0.70,
      mediumDataQuality: 0.45,
      // Credit applied to the data-quality term when a REAL lineup source has
      // confirmed the starters. Verified against ESPN: the core roster endpoint
      // returns 200 pre-game with the full squad but zero `starter`/`active`
      // flags, so this is false in production and the credit is inert.
      confirmedLineupsDqCredit: 0.05,
    },
    // Consistency check: a big spread with a very low total (or vice versa) is flagged.
    consistency: {
      bigMargin: 10,
      lowTotal: 200,
      highTotal: 245,
      minTotalForBigMargin: 205,
      maxTotalForBigMargin: 245,
    },
    noPickLabel: 'No confident pick',
    // Market priority order: highest priority first
    marketPriority: [
      'Total Points',        // Priority 1: Full-Game Total Points Over/Under
      'Spread',             // Priority 2: Point Spread
      'Team Total',          // Priority 3: Home/Away team total points Over/Under
      'First Half Total',    // Priority 4: First-Half Total Points Over/Under
      'Quarter Total',       // Priority 5: Quarter Total Points Over/Under
    ],
    // Secondary markets (team totals, halves, quarters) require higher data quality
    secondaryMarketMinDataQuality: 0.75,
    // Live auto-downgrade / disable policy driven by rolling performance.
    autoDowngrade: {
      enabled: true,
      // Rolling window (last N settled predictions) and minimum sample for a verdict.
      window: 100,
      minSample: 30,
      // Allowed gap between the average stated probability and the realised hit rate.
      tolerance: 0.07,
      // Gap (actual - predicted) at or below which a market is downgraded / disabled.
      downgradeGap: -0.07,
      disableGap: -0.15,
    },
  },

  // --- Model-generated lines (used when ESPN supplies no bookmaker odds) ---
  // Lines are expressed as half-point offsets from the model projection to avoid
  // push outcomes on model-only lines, labelled clearly as model estimates.
  modelLines: {
    enabled: true,
    // No probability threshold - show all model line predictions
    minProb: 0.0,
    // Total-line offset: generate Over/Under line at projected total + 0.5
    // (half-point above the mean; both sides should be ~50/50 there, so a 65%+
    // signal is meaningful).
    totalOffsetHalfPoint: 0.5,
    // Spread-line offset: generate a half-point spread at the projected margin + 0.5
    // for the home team, making the model slightly more conservative.
    spreadOffsetHalfPoint: 0.5,
    // Implied probability used in place of bookmaker de-vigged fair probability.
    // 0.5 means no edge exists a priori; model must earn its probability.
    impliedProb: 0.50,
    // No data quality threshold - show all model line predictions
    minDataQuality: 0.0,
  },

  // --- Data quality ---
  dataQuality: {
    minGamesPerTeam: 5,
    // Penalty weight applied while a team is below minGamesPerTeam. Ratings built
    // from a REAL prior-season baseline are genuine inputs, so they take the small
    // `priorSmallSamplePenalty`; ratings that fell back to the league mean take the
    // full 0.3 inside computeDataQuality.
    priorSmallSamplePenalty: 0.1,
    confirmedLineupsBonus: 0.05,
    missingFieldPenalty: 0.03,
    questionablePlayerPenalty: 0.05,
    noOddsPenalty: 0.10,
  },
};

module.exports = CONFIG;
