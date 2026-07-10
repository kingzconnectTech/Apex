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

