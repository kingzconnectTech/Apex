/**
 * predictabilityEngine.js
 *
 * Intelligent Predictability Scoring & High-Confidence Match Filtering Engine for Apex.
 *
 * Core Principle:
 *   Fetch all available matches. Analyse all eligible matches.
 *   Display only matches that pass the prediction engine's strict quality criteria.
 *
 * Responsibilities:
 *   1. Evaluate statistical data completeness, sample size, and consistency.
 *   2. Independently assess Home Team Under 2.5, Away Team Under 2.5, Under 4.5 FT, and Under 2.5 HT.
 *   3. Calculate predictability score, data quality score, model agreement score,
 *      and calibrated probability.
 *   4. Apply strict, configurable eligibility filters (default 75% calibrated probability,
 *      min 5 matches per team, data quality >= 0.65, model agreement >= 0.65).
 *   5. Preserve separate datasets: 'All Fixtures' vs 'Recommended Predictions'.
 *   6. Record explicit rejection reasons when a fixture/market fails eligibility.
 *   7. Rank qualified predictions using composite validation criteria.
 */

const {
  BASELINE_PRIORS,
  poissonPmf,
  poissonCdf,
  validateAndFilterHistoricalMatches,
  analyzeUnder45History,
  analyzeUnder25HtHistory,
  analyzeTeamUnder25History,
  analyzeH2HHistory,
  calculateUnder45Prediction,
  calculateUnder25HtPrediction,
  calculateTeamUnder25Prediction,
} = require('./footballHistoricalAnalysis');

// ──────────────────────────────────────────────────────────
// 1. Configurable Eligibility Filter Thresholds
// ──────────────────────────────────────────────────────────

const DEFAULT_FILTER_CONFIG = {
  /** Minimum completed historical matches with verified scores required per team */
  minSampleSizePerTeam: 5,

  /** Minimum combined sample size across both teams */
  minTotalSampleSize: 10,

  /** Minimum data quality score [0.0 - 1.0] */
  minDataQualityScore: 0.65,

  /** Minimum calibrated probability threshold for recommendation eligibility [0.0 - 1.0] (75%) */
  minCalibratedProbability: 0.75,

  /** Minimum agreement between empirical Bayesian rate and Poisson expectancy model [0.0 - 1.0] */
  minModelAgreementScore: 0.65,

  /** Minimum composite predictability score [0.0 - 1.0] */
  minPredictabilityScore: 0.65,

  /** Maximum recent goals-scored variance (penalty for extreme volatility) */
  maxRecentScoringVariance: 3.5,

  /** Whether the fixture kickoff must be in the future (relative to evaluation time) */
  requireFutureKickoff: true,
};

// ──────────────────────────────────────────────────────────
// 2. Data Quality & Statistical Scoring Helpers
// ──────────────────────────────────────────────────────────

/**
 * Calculate data quality score [0.0, 1.0] based on sample size, score completeness,
 * and chronological validity.
 *
 * @param {Array} homeMatches
 * @param {Array} awayMatches
 * @param {Object} [options]
 * @param {boolean} [options.requireHt=false]
 * @returns {number} Score between 0.0 and 1.0
 */
function calculateDataQualityScore(homeMatches = [], awayMatches = [], { requireHt = false } = {}) {
  const hList = Array.isArray(homeMatches) ? homeMatches : [];
  const aList = Array.isArray(awayMatches) ? awayMatches : [];

  if (hList.length === 0 && aList.length === 0) return 0.0;

  // 1. Sample size completeness (target: 10 matches per team = 20 total for 1.0)
  const sampleCoverage = Math.min(1.0, (hList.length + aList.length) / 16);

  // 2. Verified score ratio (pf & pa valid numbers)
  const checkScores = (list) => {
    if (list.length === 0) return 0;
    const valid = list.filter(m => m && typeof m.pf === 'number' && !isNaN(m.pf) && typeof m.pa === 'number' && !isNaN(m.pa));
    return valid.length / list.length;
  };
  const scoreCompleteness = (checkScores(hList) + checkScores(aList)) / 2;

  // 3. Chronological validity (dates valid)
  const checkDates = (list) => {
    if (list.length === 0) return 0;
    const valid = list.filter(m => m && m.date && !isNaN(new Date(m.date).getTime()));
    return valid.length / list.length;
  };
  const dateCompleteness = (checkDates(hList) + checkDates(aList)) / 2;

  // 4. Half-time score availability (if required for HT markets)
  let htCompleteness = 1.0;
  if (requireHt) {
    const checkHt = (list) => {
      if (list.length === 0) return 0;
      const valid = list.filter(m => m && m.htScore && typeof m.htScore.total === 'number');
      return valid.length / list.length;
    };
    htCompleteness = (checkHt(hList) + checkHt(aList)) / 2;
  }

  const score = (
    0.40 * sampleCoverage +
    0.35 * scoreCompleteness +
    0.15 * dateCompleteness +
    0.10 * htCompleteness
  );

  return Number(Math.max(0, Math.min(score, 1.0)).toFixed(4));
}

/**
 * Calculate form consistency [0.0, 1.0] from historical matches.
 * Lower scoring variance implies higher predictability.
 *
 * @param {Array} matches
 * @returns {{ consistencyScore: number, variance: number, avgGoals: number }}
 */
function calculateFormConsistency(matches = []) {
  const list = Array.isArray(matches) ? matches : [];
  const valid = list.filter(m => m && typeof m.pf === 'number' && !isNaN(m.pf));

  if (valid.length < 3) {
    return { consistencyScore: 0.5, variance: 2.0, avgGoals: 1.5 };
  }

  const n = valid.length;
  const avgGoals = valid.reduce((s, m) => s + m.pf, 0) / n;
  const variance = valid.reduce((s, m) => s + Math.pow(m.pf - avgGoals, 2), 0) / (n - 1);

  // Normalize: variance 0.0 -> score 1.0; variance >= 4.0 -> score 0.0
  const consistencyScore = Math.max(0, Math.min(1.0, 1.0 - (variance / 4.0)));

  return {
    consistencyScore: Number(consistencyScore.toFixed(4)),
    variance: Number(variance.toFixed(2)),
    avgGoals: Number(avgGoals.toFixed(2)),
  };
}

/**
 * Calculate model agreement score [0.0, 1.0] between empirical Bayesian rate
 * and Poisson expectancy model.
 *
 * @param {number} empiricalRate
 * @param {number} poissonProb
 * @returns {number} Agreement score [0.0, 1.0]
 */
function calculateModelAgreement(empiricalRate, poissonProb) {
  if (typeof empiricalRate !== 'number' || typeof poissonProb !== 'number') return 0.5;
  const divergence = Math.abs(empiricalRate - poissonProb);
  const agreement = Math.max(0, 1.0 - divergence);
  return Number(agreement.toFixed(4));
}

/**
 * Calculate compound Predictability Score [0.0, 1.0].
 *
 * NOTE: The predictability score reflects statistical confidence in the data's
 * reliability and model agreement. It is NOT the win probability itself.
 *
 * @param {Object} params
 * @param {number} params.dataQualityScore
 * @param {number} params.sampleSize
 * @param {number} params.formConsistency
 * @param {number} params.modelAgreement
 * @returns {number} Predictability score [0.0, 1.0]
 */
function calculatePredictabilityScore({
  dataQualityScore = 0.5,
  sampleSize = 0,
  formConsistency = 0.5,
  modelAgreement = 0.5,
}) {
  const sampleFactor = Math.min(1.0, sampleSize / 14);

  const score = (
    0.35 * dataQualityScore +
    0.25 * modelAgreement +
    0.25 * formConsistency +
    0.15 * sampleFactor
  );

  return Number(Math.max(0, Math.min(score, 1.0)).toFixed(4));
}

// ──────────────────────────────────────────────────────────
// 3. Market Candidate Evaluation & Strict Filtering
// ──────────────────────────────────────────────────────────

/**
 * Evaluate a single market prediction against strict candidate eligibility criteria.
 *
 * @param {Object} params
 * @param {string} params.market - 'home_team_under_2_5' | 'away_team_under_2_5' | 'under_4_5_goals' | 'under_2_5_ht'
 * @param {Object} params.predictionResult - Output from calculateTeamUnder25Prediction or calculateUnder45Prediction
 * @param {Array}  params.cleanHomeMatches - Cleaned home team matches
 * @param {Array}  params.cleanAwayMatches - Cleaned away team matches
 * @param {Object} [params.fixture] - Fixture details (kickoff, status, teams)
 * @param {Object} [params.config] - Custom filter thresholds
 * @returns {Object} Evaluated candidate with eligibility decision and rejection reasons
 */
function evaluateMarketCandidate({
  market,
  predictionResult,
  cleanHomeMatches = [],
  cleanAwayMatches = [],
  fixture = {},
  config = DEFAULT_FILTER_CONFIG,
}) {
  const cfg = { ...DEFAULT_FILTER_CONFIG, ...(config || {}) };
  const rejectionReasons = [];

  const hCount = cleanHomeMatches.length;
  const aCount = cleanAwayMatches.length;
  const totalSample = hCount + aCount;

  // 1. Prediction existence
  if (!predictionResult || typeof predictionResult.probability !== 'number') {
    return {
      market,
      selection: 'Under',
      is_eligible: false,
      rejection_reasons: ['No statistically valid prediction generated for this market'],
      predictability_score: 0,
      estimated_probability: 0,
      calibrated_probability: 0,
      data_quality_score: 0,
      model_agreement_score: 0,
      historical_sample_size: totalSample,
      supporting_evidence: [],
    };
  }

  const isHt = market.includes('ht');
  const dataQualityScore = calculateDataQualityScore(cleanHomeMatches, cleanAwayMatches, { requireHt: isHt });

  // 2. Form consistency & variance
  const homeForm = calculateFormConsistency(cleanHomeMatches);
  const awayForm = calculateFormConsistency(cleanAwayMatches);
  const avgFormConsistency = (homeForm.consistencyScore + awayForm.consistencyScore) / 2;

  // 3. Model agreement
  // Compare prediction's empirical base rate with its expected goals Poisson CDF
  let modelAgreementScore = 0.85; // default fallback
  if (market === 'home_team_under_2_5' || market === 'away_team_under_2_5') {
    const expGoals = predictionResult.expectedGoals || (market === 'home_team_under_2_5' ? 1.1 : 0.9);
    const poissonProb = poissonCdf(2, expGoals);
    modelAgreementScore = calculateModelAgreement(predictionResult.probability, poissonProb);
  } else if (market === 'under_4_5_goals') {
    const expGoals = predictionResult.expectedGoals || 2.4;
    const poissonProb = poissonCdf(4, expGoals);
    modelAgreementScore = calculateModelAgreement(predictionResult.probability, poissonProb);
  }

  // 4. Predictability score
  const predictabilityScore = calculatePredictabilityScore({
    dataQualityScore,
    sampleSize: totalSample,
    formConsistency: avgFormConsistency,
    modelAgreement: modelAgreementScore,
  });

  const estimatedProb = predictionResult.probability;
  const calibratedProb = Number(Math.min(0.96, Math.max(0.35, estimatedProb)).toFixed(4));

  // ─── STRICT ELIGIBILITY CHECKS ─────────────────────────

  // Check 1: Sample size per team
  if (hCount < cfg.minSampleSizePerTeam || aCount < cfg.minSampleSizePerTeam) {
    rejectionReasons.push(
      `Insufficient historical matches: Home has ${hCount}, Away has ${aCount} (min ${cfg.minSampleSizePerTeam} required per team)`
    );
  }

  // Check 2: Total sample size
  if (totalSample < cfg.minTotalSampleSize) {
    rejectionReasons.push(
      `Total sample size ${totalSample} is below required minimum of ${cfg.minTotalSampleSize}`
    );
  }

  // Check 3: Data quality score
  if (dataQualityScore < cfg.minDataQualityScore) {
    rejectionReasons.push(
      `Data quality score ${Math.round(dataQualityScore * 100)}% is below threshold of ${Math.round(cfg.minDataQualityScore * 100)}%`
    );
  }

  // Check 4: Calibrated probability threshold (75%)
  if (calibratedProb < cfg.minCalibratedProbability) {
    rejectionReasons.push(
      `Calibrated probability ${Math.round(calibratedProb * 100)}% is below required ${Math.round(cfg.minCalibratedProbability * 100)}% threshold`
    );
  }

  // Check 5: Model agreement
  if (modelAgreementScore < cfg.minModelAgreementScore) {
    rejectionReasons.push(
      `Model agreement score ${Math.round(modelAgreementScore * 100)}% indicates conflicting model signals`
    );
  }

  // Check 6: Predictability score
  if (predictabilityScore < cfg.minPredictabilityScore) {
    rejectionReasons.push(
      `Predictability index ${Math.round(predictabilityScore * 100)}% does not meet strict confidence criteria`
    );
  }

  // Check 7: Future kickoff requirement
  if (cfg.requireFutureKickoff && fixture?.date) {
    const kickoffTs = new Date(fixture.date).getTime();
    if (!isNaN(kickoffTs) && kickoffTs <= Date.now()) {
      rejectionReasons.push('Fixture kickoff is in the past or match is already underway');
    }
  }

  // Check 8: Extreme volatility / variance penalty
  if (homeForm.variance > cfg.maxRecentScoringVariance || awayForm.variance > cfg.maxRecentScoringVariance) {
    rejectionReasons.push(
      `Recent scoring variance too high (Home: ${homeForm.variance}, Away: ${awayForm.variance}), indicating volatile form`
    );
  }

  const isEligible = rejectionReasons.length === 0;

  // Build supporting evidence bullet points
  const supportingEvidence = [];
  if (predictionResult.factors && Array.isArray(predictionResult.factors)) {
    predictionResult.factors.forEach(f => supportingEvidence.push(f.label));
  } else {
    supportingEvidence.push(`Historical sample: ${totalSample} completed matches analyzed`);
    supportingEvidence.push(`Data quality completeness: ${Math.round(dataQualityScore * 100)}%`);
    supportingEvidence.push(`Model consistency agreement: ${Math.round(modelAgreementScore * 100)}%`);
  }

  return {
    market,
    label: predictionResult.label || market,
    value: predictionResult.value || market,
    selection: 'Under 2.5',
    is_eligible: isEligible,
    rejection_reasons: rejectionReasons,
    predictability_score: predictabilityScore,
    estimated_probability: estimatedProb,
    calibrated_probability: calibratedProb,
    confidence: Math.round(calibratedProb * 100),
    data_quality_score: dataQualityScore,
    model_agreement_score: modelAgreementScore,
    historical_sample_size: totalSample,
    supporting_evidence: supportingEvidence,
    color: predictionResult.color || (isEligible ? '#40c057' : '#868e96'),
    expectedGoals: predictionResult.expectedGoals || null,
  };
}

// ──────────────────────────────────────────────────────────
// 4. Fixture Analysis & Recommendation Filter
// ──────────────────────────────────────────────────────────

/**
 * Analyse all supported markets for a football fixture and determine whether
 * it qualifies for the high-confidence recommendations feed.
 *
 * @param {Object} fixture - Normalized fixture object
 * @param {Object} matchData - { cleanHomeMatches, cleanAwayMatches, h2h, homeName, awayName }
 * @param {Object} [config] - Filter configuration
 * @returns {Object} Comprehensive evaluation result
 */
function evaluateFixture({
  fixture,
  cleanHomeMatches = [],
  cleanAwayMatches = [],
  h2h = null,
  homeName = 'Home Team',
  awayName = 'Away Team',
  config = DEFAULT_FILTER_CONFIG,
}) {
  const cfg = { ...DEFAULT_FILTER_CONFIG, ...(config || {}) };

  // 1. Run historical analysis models for all 4 key football markets
  const homeU45 = analyzeUnder45History(cleanHomeMatches);
  const awayU45 = analyzeUnder45History(cleanAwayMatches);
  const homeHt = analyzeUnder25HtHistory(cleanHomeMatches);
  const awayHt = analyzeUnder25HtHistory(cleanAwayMatches);
  const homeTeamU25 = analyzeTeamUnder25History(cleanHomeMatches, { isHomeContext: true });
  const awayTeamU25 = analyzeTeamUnder25History(cleanAwayMatches, { isHomeContext: false });

  // H2H analysis
  let h2hAnalysis = null;
  if (h2h?.recent && Array.isArray(h2h.recent)) {
    const mapped = h2h.recent.filter(g => g.score && g.score.includes('-')).map(g => {
      const parts = g.score.split('-').map(s => parseInt(s, 10));
      return { id: g.id, date: g.date, pf: parts[0], pa: parts[1], isHome: true, htScore: null };
    });
    h2hAnalysis = analyzeH2HHistory(mapped);
  }

  // 2. Generate raw model predictions
  const predHomeU25 = calculateTeamUnder25Prediction({
    teamAnalysis: homeTeamU25,
    oppAnalysis: awayTeamU25,
    isHome: true,
    teamName: homeName,
    oppName: awayName,
    h2hAnalysis,
  });

  const predAwayU25 = calculateTeamUnder25Prediction({
    teamAnalysis: awayTeamU25,
    oppAnalysis: homeTeamU25,
    isHome: false,
    teamName: awayName,
    oppName: homeName,
    h2hAnalysis,
  });

  const predU45 = calculateUnder45Prediction({
    homeAnalysis: homeU45,
    awayAnalysis: awayU45,
    h2hAnalysis,
  });

  const predU25Ht = calculateUnder25HtPrediction({
    homeHtAnalysis: homeHt,
    awayHtAnalysis: awayHt,
    h2hAnalysis,
  });

  // 3. Evaluate each market candidate with strict eligibility filters
  const candidateMarkets = [
    { market: 'home_team_under_2_5', pred: predHomeU25 },
    { market: 'away_team_under_2_5', pred: predAwayU25 },
    { market: 'under_4_5_goals', pred: predU45 },
    { market: 'under_2_5_ht', pred: predU25Ht },
  ];

  const evaluatedCandidates = candidateMarkets.map(item =>
    evaluateMarketCandidate({
      market: item.market,
      predictionResult: item.pred,
      cleanHomeMatches,
      cleanAwayMatches,
      fixture,
      config: cfg,
    })
  );

  // 4. Separate eligible from rejected
  const eligibleCandidates = evaluatedCandidates.filter(c => c.is_eligible);
  const rejectedCandidates = evaluatedCandidates.filter(c => !c.is_eligible);

  // 5. Rank eligible candidates using validated composite score
  // Composite score: 70% calibrated probability + 30% predictability index
  eligibleCandidates.sort((a, b) => {
    const scoreA = (a.calibrated_probability * 0.70) + (a.predictability_score * 0.30);
    const scoreB = (b.calibrated_probability * 0.70) + (b.predictability_score * 0.30);
    return scoreB - scoreA;
  });

  const isRecommended = eligibleCandidates.length > 0;
  const topCandidate = isRecommended ? eligibleCandidates[0] : null;

  // Confidence label based on validated probability
  let confidenceLabel = 'Unvalidated';
  if (topCandidate) {
    if (topCandidate.calibrated_probability >= 0.85) {
      confidenceLabel = 'Very High Confidence (Validated)';
    } else if (topCandidate.calibrated_probability >= 0.80) {
      confidenceLabel = 'High Confidence (Validated)';
    } else if (topCandidate.calibrated_probability >= 0.75) {
      confidenceLabel = 'Qualified High Confidence';
    }
  }

  // Compile general rejection reasons for this fixture if none qualified
  const fixtureRejectionReasons = [];
  if (!isRecommended) {
    // Collect unique rejection reasons across evaluated markets
    const seen = new Set();
    rejectedCandidates.forEach(rc => {
      (rc.rejection_reasons || []).forEach(reason => {
        if (!seen.has(reason)) {
          seen.add(reason);
          fixtureRejectionReasons.push(reason);
        }
      });
    });
  }

  return {
    fixtureId: fixture?.id || fixture?.fixture?.id || null,
    homeName,
    awayName,
    league: fixture?.league?.name || fixture?.league || 'Unknown Competition',
    date: fixture?.date || fixture?.fixture?.date || null,
    isRecommended,
    confidenceLabel,
    topCandidate,
    eligibleCandidates,
    rejectedCandidates,
    fixtureRejectionReasons,
    totalCandidatesEvaluated: evaluatedCandidates.length,
    totalCandidatesPassed: eligibleCandidates.length,
  };
}

// ──────────────────────────────────────────────────────────
// 5. Batch Pipeline: All Fixtures vs Recommended Predictions
// ──────────────────────────────────────────────────────────

/**
 * Filter an array of evaluated fixtures into:
 *   1. Recommended Predictions (Selective, strict criteria met)
 *   2. All Fixtures (Full browsable dataset, with rejection reasons)
 *
 * @param {Array} evaluatedFixturesList - Array of evaluateFixture() results
 * @returns {Object} { recommended, allFixtures, stats }
 */
function filterAndRankFixtures(evaluatedFixturesList = []) {
  const allList = Array.isArray(evaluatedFixturesList) ? evaluatedFixturesList : [];

  const recommended = [];
  const allFixtures = [];
  const rejectionCounts = {};

  allList.forEach(item => {
    allFixtures.push(item);

    if (item.isRecommended && item.topCandidate) {
      recommended.push({
        fixtureId: item.fixtureId,
        homeName: item.homeName,
        awayName: item.awayName,
        league: item.league,
        date: item.date,
        market: item.topCandidate.market,
        label: item.topCandidate.label,
        selection: item.topCandidate.selection,
        calibratedProbability: item.topCandidate.calibrated_probability,
        confidence: item.topCandidate.confidence,
        predictabilityScore: item.topCandidate.predictability_score,
        dataQualityScore: item.topCandidate.data_quality_score,
        modelAgreementScore: item.topCandidate.model_agreement_score,
        sampleSize: item.topCandidate.historical_sample_size,
        confidenceLabel: item.confidenceLabel,
        supportingEvidence: item.topCandidate.supporting_evidence,
        allEligibleMarkets: item.eligibleCandidates,
      });
    } else {
      (item.fixtureRejectionReasons || []).forEach(reason => {
        const key = reason.split(':')[0] || reason;
        rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
      });
    }
  });

  // Rank recommended fixtures by calibrated probability and predictability
  recommended.sort((a, b) => {
    const rankA = (a.calibratedProbability * 0.70) + (a.predictabilityScore * 0.30);
    const rankB = (b.calibratedProbability * 0.70) + (b.predictabilityScore * 0.30);
    return rankB - rankA;
  });

  const totalAnalyzed = allList.length;
  const totalRecommended = recommended.length;
  const totalRejected = totalAnalyzed - totalRecommended;
  const acceptanceRate = totalAnalyzed > 0 ? Number(((totalRecommended / totalAnalyzed) * 100).toFixed(1)) : 0;

  return {
    recommended,
    allFixtures,
    stats: {
      totalRetrieved: totalAnalyzed,
      totalAnalyzed,
      totalRejected,
      totalRecommended,
      acceptanceRate,
      rejectionReasonBreakdown: rejectionCounts,
    },
  };
}

// ──────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_FILTER_CONFIG,
  calculateDataQualityScore,
  calculateFormConsistency,
  calculateModelAgreement,
  calculatePredictabilityScore,
  evaluateMarketCandidate,
  evaluateFixture,
  filterAndRankFixtures,
};
