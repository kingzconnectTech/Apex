import { API_URL } from '../constants/config';

/**
 * Fetch a full match prediction from the backend.
 * The backend fetches ESPN data server-side, runs analyzeMatchServer,
 * caches the result for 2 minutes, and returns structured prediction output.
 *
 * @param {string|number} matchId      - ESPN event/match ID
 * @param {string}        sport        - 'soccer' | 'basketball' | 'tennis'
 * @param {string}        leagueSlug   - ESPN league slug (e.g. 'eng.1', 'nba')
 * @param {string|number} homeTeamId   - ESPN team ID for home side
 * @param {string|number} awayTeamId   - ESPN team ID for away side
 * @returns {Promise<Object|null>} prediction object or null on failure
 */
export const fetchMatchPrediction = async (matchId, sport, leagueSlug, homeTeamId, awayTeamId) => {
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
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.warn(
        `[fetchMatchPrediction] Backend error ${response.status}:`,
        errorBody.error || 'Unknown error'
      );
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('[fetchMatchPrediction] Network error:', error.message);
    return null;
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


