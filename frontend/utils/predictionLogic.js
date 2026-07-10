/**
 * ⚠️  DEPRECATED — DO NOT USE
 *
 * This file has been intentionally emptied as part of the backend migration.
 * All match prediction logic now runs server-side via POST /api/match-prediction.
 *
 * Frontend prediction requests must use:
 *   import { fetchMatchPrediction } from '../services/api';
 *
 * This file is kept to prevent broken-import errors in IDEs until it can be
 * physically deleted. Any import of analyzeMatch from this file will throw.
 */

export const analyzeMatch = () => {
  throw new Error(
    '[analyzeMatch] REMOVED: Prediction logic has been migrated to the backend. ' +
    'Use fetchMatchPrediction from services/api.js instead.'
  );
};
