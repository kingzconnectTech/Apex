/**
 * Basketball prediction API.
 *
 * Mounted at `/api`, exposing:
 *   GET /api/basketball/predictions?date=&league=
 *   GET /api/basketball/predictions/:gameId
 *   GET /api/basketball/performance
 *   GET /api/basketball/leagues
 *
 * Predictions are statistical estimates, not betting advice.
 */

const express = require('express');
const { getPredictions, getGamePrediction } = require('../services/basketball/ingestion');
const { getBasketballPerformance } = require('../services/basketball/persistence');
const { listLeagues } = require('../services/basketball/leagues');
const CONFIG = require('../services/basketball/config');

const DISCLAIMER = 'Predictions are statistical estimates, not betting advice. A 68% pick still loses about 1 in 3 times.';

function createBasketballRouter({ sportsData, admin, logger = null } = {}) {
  const router = express.Router();

  router.get('/basketball/leagues', (req, res) => {
    res.json({
      leagues: listLeagues().map(l => ({
        key: l.key, label: l.label, gameMinutes: l.gameMinutes,
        sigma: l.sigma, homeCourtPoints: l.homeCourtPoints,
      })),
      modelVersion: CONFIG.modelVersion,
    });
  });

  router.get('/basketball/predictions', async (req, res) => {
    const traceId = req.traceId || null;
    try {
      const { date = null, league = null, confidence = null, market = null } = req.query;
      const leagues = league ? [league] : null;

      const predictions = await getPredictions({ sportsData, leagues, date, traceId });

      // Apply confidence threshold per pick (per market)
      // Each individual pick must have probability >= threshold to be displayed
      const THRESHOLD = 0.30;
      let filtered = predictions.map(pred => {
        const filteredPicks = (pred.picks || []).filter(pick => pick.probability >= THRESHOLD);
        return { ...pred, picks: filteredPicks };
      }).filter(pred => pred.picks.length > 0);

      // Additional optional filters
      if (confidence) filtered = filtered.filter(p => p.picks.some(pk => pk.confidence === confidence));
      if (market) filtered = filtered.filter(p => p.picks.some(pk => pk.market === market));

      res.json({
        date: date || new Date().toISOString().slice(0, 10),
        league: league || 'all',
        count: filtered.length,
        predictions: filtered,
        modelVersion: CONFIG.modelVersion,
        disclaimer: DISCLAIMER,
      });
    } catch (err) {
      logger?.log('error', '[BASKETBALL] predictions failed', { traceId, error: err?.message });
      res.status(500).json({ error: 'Failed to generate basketball predictions', detail: err?.message });
    }
  });

  router.get('/basketball/predictions/:gameId', async (req, res) => {
    const traceId = req.traceId || null;
    try {
      const { gameId } = req.params;
      const { league } = req.query;
      if (!league) return res.status(400).json({ error: 'league query parameter is required' });

      const found = await getGamePrediction({ sportsData, gameId, league, traceId });
      if (!found) return res.status(404).json({ error: `No basketball game ${gameId} found for league ${league}` });

      // Apply confidence threshold per pick
      const THRESHOLD = 0.30;
      const formatted = found.formatted;
      const filteredPicks = (formatted.picks || []).filter(pick => pick.probability >= THRESHOLD);

      if (filteredPicks.length === 0) {
        return res.json({
          ...formatted,
          picks: [],
          message: 'No picks meet the 30% confidence threshold',
          disclaimer: DISCLAIMER,
        });
      }

      res.json({ ...formatted, picks: filteredPicks, disclaimer: DISCLAIMER });
    } catch (err) {
      logger?.log('error', '[BASKETBALL] game prediction failed', { traceId, gameId: req.params.gameId, error: err?.message });
      res.status(500).json({ error: 'Failed to generate basketball prediction', detail: err?.message });
    }
  });

  router.get('/basketball/performance', async (req, res) => {
    try {
      if (!admin) return res.status(503).json({ error: 'Persistence not configured' });
      const { league = null, window = 100 } = req.query;
      const report = await getBasketballPerformance(admin, { league, window: Number(window) || 100 });
      res.json({ ...report, disclaimer: DISCLAIMER });
    } catch (err) {
      logger?.log('error', '[BASKETBALL] performance failed', { error: err?.message });
      res.status(500).json({ error: 'Failed to load basketball performance', detail: err?.message });
    }
  });

  return router;
}

module.exports = { createBasketballRouter, DISCLAIMER };
