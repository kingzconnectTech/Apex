import { API_URL } from '../constants/config';

/**
 * Fetch a full match prediction from the backend.
 * The backend first checks Firestore for a saved prediction (preserving original data).
 * If not found, it fetches ESPN data server-side, runs analyzeMatchServer,
 * caches the result for 2 minutes, and returns structured prediction output.
 *
 * @param {string|number} matchId      - ESPN event/match ID
 * @param {string}        sport        - 'soccer' | 'basketball' | 'tennis'
 * @param {string}        leagueSlug   - ESPN league slug (e.g. 'eng.1', 'nba')
 * @param {string|number} homeTeamId   - ESPN team ID for home side
 * @param {string|number} awayTeamId   - ESPN team ID for away side
 * @param {string}        [userId]     - User ID to check for saved predictions
 * @returns {Promise<Object>} On success the prediction payload. On failure an
 *   `{ unavailable: true, httpStatus, code, message }` marker so callers can
 *   distinguish insufficient data / provider failure / generation failure
 *   instead of collapsing everything into one generic message.
 */
export const fetchMatchPrediction = async (matchId, sport, leagueSlug, homeTeamId, awayTeamId, userId = null) => {
  try {
    const response = await fetch(`${API_URL}/api/match-prediction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId: String(matchId),
        sport,
        leagueSlug,
        homeTeamId: String(homeTeamId),
        awayTeamId: String(awayTeamId),
        userId: userId || undefined,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.warn(
        `[fetchMatchPrediction] Backend error ${response.status}:`,
        errorBody.error || 'Unknown error'
      );
      return {
        unavailable: true,
        httpStatus: response.status,
        code: errorBody.code || null,
        message: errorBody.error || null,
      };
    }

    return await response.json();
  } catch (error) {
    console.warn('[fetchMatchPrediction] Network error:', error.message);
    return {
      unavailable: true,
      httpStatus: 0,
      code: 'NETWORK_ERROR',
      message: error.message,
    };
  }
};

export const checkBackendHealth = async () => {
    try {
        const response = await fetch(`${API_URL}/`);
        return response.ok;
    } catch (e) {
        return false;
    }
};

/**
 * Fetch all 77 football leagues available from PitchAPI / backend.
 * @returns {Promise<Array>} array of normalized league objects
 */
export const fetchSportsDataLeagues = async () => {
  try {
    const response = await fetch(`${API_URL}/api/sports-data/leagues`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.leagues || [];
  } catch (error) {
    console.warn('[fetchSportsDataLeagues] Network error:', error.message);
    return [];
  }
};

/**
 * Save user's unlocked prediction to backend for persistence & automatic settlement.
 */
export const savePredictionToBackend = async (predictionData) => {
  try {
    const response = await fetch(`${API_URL}/api/predictions/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(predictionData),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn('[savePredictionToBackend] Network error:', error.message);
    return null;
  }
};

/**
 * Fetch verified settlement result for a specific match.
 */
export const fetchPredictionSettlement = async (matchId, userId = null) => {
  try {
    const url = `${API_URL}/api/predictions/settlement/${matchId}${userId ? `?userId=${userId}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.settlement || null;
  } catch (error) {
    console.warn('[fetchPredictionSettlement] Network error:', error.message);
    return null;
  }
};

/**
 * Fetch prediction history with won/lost tick/cross status.
 */
export const fetchPredictionHistory = async (userId, status = 'all', limit = 50) => {
  try {
    const response = await fetch(`${API_URL}/api/predictions/history?userId=${userId}&status=${status}&limit=${limit}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.history || [];
  } catch (error) {
    console.warn('[fetchPredictionHistory] Network error:', error.message);
    return [];
  }
};

/**
 * Fetch user prediction statistics (win rate, won, lost, pending).
 */
export const fetchPredictionStats = async (userId) => {
  try {
    const response = await fetch(`${API_URL}/api/predictions/stats?userId=${userId}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.stats || null;
  } catch (error) {
    console.warn('[fetchPredictionStats] Network error:', error.message);
    return null;
  }
};

/**
 * Fetch paginated fixture catalog across all configured providers and leagues.
 *
 * @param {Object} options
 * @param {string} [options.sport='soccer']
 * @param {string} [options.league]
 * @param {string} [options.date]
 * @param {string} [options.status='all']
 * @param {number} [options.page=1]
 * @param {number} [options.limit=30]
 * @returns {Promise<Object>} { success, fixtures, total, totalPages, page, limit }
 */
export const fetchAllFixtures = async ({ sport = 'soccer', league = null, date = null, status = 'all', page = 1, limit = 30 } = {}) => {
  try {
    const params = new URLSearchParams();
    if (sport) params.append('sport', sport);
    if (league && league !== 'All' && league !== 'Live') params.append('league', league);
    if (date) params.append('date', date);
    if (status && status !== 'all') params.append('status', status);
    params.append('page', String(page));
    params.append('limit', String(limit));

    const response = await fetch(`${API_URL}/api/fixtures/all?${params.toString()}`);
    if (!response.ok) {
      return { success: false, fixtures: [], total: 0, totalPages: 0, page: 1 };
    }
    return await response.json();
  } catch (error) {
    console.warn('[fetchAllFixtures] Network error:', error.message);
    return { success: false, fixtures: [], total: 0, totalPages: 0, page: 1 };
  }
};

/**
 * Fetch calibrated basketball predictions (Total Points + Spread) for a date.
 *
 * Backed by GET /api/basketball/predictions. Every prediction carries both
 * picks (or an explicit "no confident pick"), a projection and a data-quality
 * score — the UI never invents values.
 *
 * @param {Object} options
 * @param {string} [options.date]        - ISO date (YYYY-MM-DD)
 * @param {string} [options.league]      - backend league key (nba|wnba|ncaa|euroleague)
 * @param {string} [options.confidence]  - High | Medium | Low
 * @param {string} [options.market]      - 'Total Points' | 'Spread'
 * @returns {Promise<Object>} { success, predictions, count, disclaimer, modelVersion }
 */
export const fetchBasketballPredictions = async ({ date = null, league = null, confidence = null, market = null } = {}) => {
  try {
    const params = new URLSearchParams();
    if (date) params.append('date', date);
    if (league && league !== 'All' && league !== 'Live') params.append('league', league);
    if (confidence && confidence !== 'All') params.append('confidence', confidence);
    if (market && market !== 'All') params.append('market', market);

    const query = params.toString();
    const response = await fetch(`${API_URL}/api/basketball/predictions${query ? `?${query}` : ''}`);
    if (!response.ok) {
      return { success: false, predictions: [], count: 0, disclaimer: null };
    }
    const data = await response.json();
    return {
      success: true,
      predictions: Array.isArray(data.predictions) ? data.predictions : [],
      count: data.count || 0,
      date: data.date || date,
      league: data.league || 'all',
      modelVersion: data.modelVersion || null,
      disclaimer: data.disclaimer || null,
    };
  } catch (error) {
    console.warn('[fetchBasketballPredictions] Network error:', error.message);
    return { success: false, predictions: [], count: 0, disclaimer: null };
  }
};

/**
 * Run comprehensive transparent evaluation on a single fixture.
 */
export const evaluateFixtureBackend = async ({ fixture, homeMatches, awayMatches, homeName, awayName, h2h }) => {
  try {
    const response = await fetch(`${API_URL}/api/fixtures/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture, homeMatches, awayMatches, homeName, awayName, h2h }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn('[evaluateFixtureBackend] Network error:', error.message);
    return null;
  }
};

/* --------------------------------------------------------------------------
 * Live Game Analysis (Phase 6)
 *
 * These mirror the fetchMatchPrediction convention: on failure they resolve to
 * an `{ unavailable: true, httpStatus, code, message }` marker so the UI can
 * tell a provider outage apart from "the link was not recognised" or "the model
 * has not passed backtesting". The pasted link is sent for identification only.
 * ------------------------------------------------------------------------ */

const liveFailure = (response, body) => ({
  unavailable: true,
  httpStatus: response.status,
  code: body.code || null,
  message: body.error || null,
  errors: Array.isArray(body.errors) ? body.errors : undefined,
});

/**
 * What the live feature is currently allowed to do.
 * @returns {Promise<Object>} { enabled, sports, supported_sports, shipping, refresh, disclaimer }
 */
export const fetchLiveCapabilities = async () => {
  try {
    const response = await fetch(`${API_URL}/api/live/capabilities`);
    if (!response.ok) return { unavailable: true, httpStatus: response.status, code: null, message: null };
    return await response.json();
  } catch (error) {
    console.warn('[fetchLiveCapabilities] Network error:', error.message);
    return { unavailable: true, httpStatus: 0, code: 'NETWORK_ERROR', message: error.message };
  }
};

/**
 * Identify the game behind a pasted bookmaker link.
 * @param {string} link
 * @returns {Promise<Object>} { status: 'matched'|'candidates'|'none', game?, analysis?, candidates?, reason?, manual_entry_required }
 */
export const resolveLiveLink = async (link) => {
  try {
    const response = await fetch(`${API_URL}/api/live/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return liveFailure(response, body);
    return body;
  } catch (error) {
    console.warn('[resolveLiveLink] Network error:', error.message);
    return { unavailable: true, httpStatus: 0, code: 'NETWORK_ERROR', message: error.message };
  }
};

/**
 * Poll the live analysis for an already-resolved game.
 * @param {string} gameId  e.g. 'espn:401234567'
 */
export const fetchLiveAnalysis = async (gameId) => {
  try {
    const response = await fetch(`${API_URL}/api/live/analysis/${encodeURIComponent(gameId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return liveFailure(response, body);
    return body;
  } catch (error) {
    console.warn('[fetchLiveAnalysis] Network error:', error.message);
    return { unavailable: true, httpStatus: 0, code: 'NETWORK_ERROR', message: error.message };
  }
};

/**
 * Analyse a game the user typed in, when no link could be matched.
 * @param {Object} input { sport, home_name, away_name, home_score, away_score, period, clock, status }
 */
export const fetchLiveManualAnalysis = async (input) => {
  try {
    const response = await fetch(`${API_URL}/api/live/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return liveFailure(response, body);
    return body;
  } catch (error) {
    console.warn('[fetchLiveManualAnalysis] Network error:', error.message);
    return { unavailable: true, httpStatus: 0, code: 'NETWORK_ERROR', message: error.message };
  }
};

/* --------------------------------------------------------------------------
 * Live Matches (FlashScore / LiveScore)
 *
 * The SERVER reads the two public score sites and returns the games in play; the
 * app opens any match — or the user's own preferred link — in an in-app browser.
 * `validateSiteLink` checks a pasted link BEFORE it is opened, so a non-http(s)
 * URL never reaches the WebView.
 * ------------------------------------------------------------------------ */

/**
 * List the games that are in play right now.
 * @param {Object}   [options]
 * @param {string[]} [options.sources] restrict to source ids (e.g. ['flashscore'])
 * @param {boolean}  [options.force]   bypass the short server-side cache
 * @returns {Promise<Object>} { enabled, count, fetched_at, degraded, refresh, sources, sites, matches }
 */
export const fetchLiveMatches = async ({ sources = null, force = false } = {}) => {
  try {
    const params = new URLSearchParams();
    if (Array.isArray(sources) && sources.length) params.append('sources', sources.join(','));
    if (force) params.append('force', 'true');
    const query = params.toString();
    const response = await fetch(`${API_URL}/api/live/matches${query ? `?${query}` : ''}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return liveFailure(response, body);
    return body;
  } catch (error) {
    console.warn('[fetchLiveMatches] Network error:', error.message);
    return { unavailable: true, httpStatus: 0, code: 'NETWORK_ERROR', message: error.message };
  }
};

/**
 * Check a link the user supplies before it is opened in the in-app browser.
 *
 * The route always answers 200 with the verdict in `valid` + `reason` (a bad
 * link is data, not a request failure), so the UI renders the reason inline.
 * @param {string} link
 * @returns {Promise<Object>} { valid, reason?, url?, site_id?, site_name?, recognised?, note? }
 */
export const validateSiteLink = async (link) => {
  try {
    const response = await fetch(`${API_URL}/api/live/validate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return liveFailure(response, body);
    return body;
  } catch (error) {
    console.warn('[validateSiteLink] Network error:', error.message);
    return { unavailable: true, httpStatus: 0, code: 'NETWORK_ERROR', message: error.message };
  }
};




