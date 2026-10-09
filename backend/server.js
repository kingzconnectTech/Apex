require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const cron = require('node-cron');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const { SportsDataService } = require('./services/SportsDataService');
const { rankFootballPredictions, FOOTBALL_MARKET_PRIORITY: _FOOTBALL_MARKET_PRIORITY } = require('./services/footballRanking');

const IS_ENTRY_POINT = require.main === module;

// Logger Configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'audit.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const compression = require('compression');

// Initialize Sports Data Service (ESPN primary + PitchAPI fallback)
const sportsData = new SportsDataService({ logger });
logger.info('SportsDataService initialized', { providers: sportsData.getProvidersStatus() });

// Initialize Express app
const app = express();
app.use(compression()); // Enable Gzip compression
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3000;

// Trace ID Middleware
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firebase Admin SDK
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    logger.info('Firebase Admin SDK initialized using environment variable');
  } else {
    serviceAccount = require('./serviceAccountKey.json');
    logger.info('Firebase Admin SDK initialized using serviceAccountKey.json');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  logger.info('Firebase Admin SDK initialized successfully');
} catch (error) {
  logger.warn('Firebase Admin SDK not initialized: ' + error.message);
}

// ----------------------------------------------------------
// ESPN Proxy with Event-Driven Real-Time Refresh
// ----------------------------------------------------------
const ESPN_BASE = 'http://site.api.espn.com/apis/site/v2/sports';

// Football markets configuration
// Default corners threshold used when H2H data is unavailable.
const FOOTBALL_UNDER_CORNERS_LINE = parseFloat(process.env.FOOTBALL_UNDER_CORNERS_LINE) || 10.5;

// Approved football markets (in tie-break priority order)
const FOOTBALL_MARKET_PRIORITY = ['under_4_5_goals', 'under_2_5_ht', 'under_corners', 'under_1_5_ht'];

// Enhanced Cache
// key: full ESPN URL
// value: { data: any, expiresAt: number, lastModified: string, hash: string }
const cache = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_TTL_MS = 30 * 1000; // Trigger fresh fetch if data is older than 30 seconds

const getHash = (data) => crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');

function setCache(key, data, ttl = DEFAULT_TTL_MS) {
  const hash = getHash(data);
  const entry = { 
    data, 
    expiresAt: Date.now() + ttl,
    lastUpdated: Date.now(),
    hash 
  };
  cache.set(key, entry);
  return entry;
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return item;
}

// Helper function to fetch data (using cache if available)
async function fetchFromBackendOrESPN(target) {
  const upstreamUrl = `${ESPN_BASE}/${target}`;
  
  // Check cache first
  const cached = getCache(upstreamUrl);
  if (cached) {
    return cached.data;
  }
  
  // Fetch fresh data
  const data = await fetchWithRetry(upstreamUrl, uuidv4());
  setCache(upstreamUrl, data);
  return data;
}

async function fetchWithRetry(targetUrl, traceId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const start = Date.now();
      const res = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'apex-backend/1.0',
          'X-Trace-ID': traceId
        },
      });
      
      const duration = Date.now() - start;
      
      if (!res.ok) {
        throw new Error(`Upstream error ${res.status}`);
      }
      
      const data = await res.json();
      logger.info('Upstream fetch success', { traceId, targetUrl, duration, attempt: i + 1 });
      return data;
    } catch (e) {
      logger.error('Upstream fetch attempt failed', { traceId, targetUrl, attempt: i + 1, error: e.message });
      if (i === retries - 1) throw e;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

// Background refresh and notify
async function refreshAndNotify(key, traceId) {
  try {
    const newData = await fetchWithRetry(key, traceId);
    const oldEntry = cache.get(key);
    const newHash = getHash(newData);
    
    if (!oldEntry || oldEntry.hash !== newHash) {
      setCache(key, newData);
      io.emit('data_updated', { url: key, traceId, timestamp: Date.now() });
      logger.info('Cache refreshed and clients notified', { traceId, key });
    } else {
      // Just update expiresAt if hash is same
      oldEntry.expiresAt = Date.now() + DEFAULT_TTL_MS;
      oldEntry.lastUpdated = Date.now();
    }
  } catch (e) {
    logger.error('Background refresh failed', { traceId, key, error: e.message });
  }
}

function isValidRelativeTarget(target) {
  if (!target || typeof target !== 'string') return false;
  if (target.includes('..')) return false;
  if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('//')) return false;
  return true;
}

// GET /api/proxy
app.get('/api/proxy', async (req, res) => {
  const { traceId } = req;
  const { target, force } = req.query;
  let upstreamUrl;

  try {
    if (!isValidRelativeTarget(target)) {
      return res.status(400).json({ error: 'Invalid target', traceId });
    }
    upstreamUrl = `${ESPN_BASE}/${target}`;

    const cached = getCache(upstreamUrl);
    
    // If we have cached data, return it immediately
    if (cached) {
      // Check if we should refresh in the background
      if (force || (Date.now() - cached.lastUpdated > STALE_TTL_MS)) {
        logger.info('Returning cached data and refreshing in background', { traceId, target });
        refreshAndNotify(upstreamUrl, traceId);
      }
      return res.json(cached.data);
    }

    // If no cache, fetch fresh data
    logger.info('No cached data found, fetching fresh', { traceId, target });
    const data = await fetchWithRetry(upstreamUrl, traceId);
    setCache(upstreamUrl, data);
    io.emit('data_updated', { url: upstreamUrl, traceId, timestamp: Date.now() });
    return res.json(data);
  } catch (e) {
    logger.error('Proxy error', { traceId, target, error: e.message });
    
    // Fallback: If fetch fails but we have stale data, return it as a last resort
    if (upstreamUrl) {
      const cached = getCache(upstreamUrl);
      if (cached) {
        logger.warn('Returning stale data after fetch failure', { traceId, target });
        return res.json(cached.data);
      }
    }
    
    return res.status(502).json({ error: 'Upstream fetch failed', traceId });
  }
});

// Periodic cache cleanup
if (IS_ENTRY_POINT) cron.schedule('*/5 * * * *', () => {
  const nowTs = Date.now();
  let removedProxy = 0;
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt < nowTs) {
      cache.delete(key);
      removedProxy++;
    }
  }
  let removedPred = 0;
  for (const [k, v] of predictionCache.entries()) {
    if (v.expiresAt < nowTs) { predictionCache.delete(k); removedPred++; }
  }
  const removedShared = sportsData.purgeExpired();
  const total = removedProxy + removedPred + removedShared;
  if (total > 0) {
    logger.info(`Cache cleanup: removed ${total} expired entries`, {
      espnProxy: removedProxy,
      predictions: removedPred,
      sportsDataShared: removedShared,
    });
  }
});

// Automated stats update for all leagues (every 15 minutes)
const leaguesToRefresh = [
  // Top Soccer Leagues
  { sport: 'soccer', league: 'eng.1' },
  { sport: 'soccer', league: 'esp.1' },
  { sport: 'soccer', league: 'ita.1' },
  { sport: 'soccer', league: 'ger.1' },
  { sport: 'soccer', league: 'fra.1' },
  { sport: 'soccer', league: 'ned.1' },
  { sport: 'soccer', league: 'por.1' },
  { sport: 'soccer', league: 'tur.1' },
  { sport: 'soccer', league: 'uefa.champions' },
  { sport: 'soccer', league: 'uefa.europa' },
  { sport: 'soccer', league: 'mex.1' },
  { sport: 'soccer', league: 'bra.1' },
  { sport: 'soccer', league: 'arg.1' },
  { sport: 'soccer', league: 'usa.1' },
  
  // Top Basketball Leagues
  { sport: 'basketball', league: 'nba' },
  { sport: 'basketball', league: 'wnba' },
  
  // Top Tennis Leagues
  { sport: 'tennis', league: 'atp' },
  { sport: 'tennis', league: 'wta' }
];

if (IS_ENTRY_POINT) cron.schedule('*/15 * * * *', async () => {
  const traceId = uuidv4();
  logger.info('Starting automated stats refresh for all leagues...', { traceId });
  
  let successCount = 0;
  let errorCount = 0;
  let afSuccess = 0;
  let afError = 0;
  let afFixturesWarmed = 0;
  const sportSet = new Set();
  
  const refreshPromises = leaguesToRefresh.map(async (leagueConfig) => {
    const { sport, league } = leagueConfig;
    sportSet.add(sport);
    try {
      const target = `${sport}/${league}/scoreboard`;
      const upstreamUrl = `${ESPN_BASE}/${target}`;
      await refreshAndNotify(upstreamUrl, traceId);
      successCount++;
      logger.debug('Refreshed league stats', { traceId, sport, league });
    } catch (err) {
      errorCount++;
      logger.error('Failed to refresh league stats', {
        traceId,
        sport,
        league,
        error: err.message
      });
    }

    if ((sport === 'soccer' || sport === 'football') && sportsData && typeof sportsData.getFixtures === 'function') {
      try {
        const name = `${sport}/${league}`;
        const fx = await sportsData.getFixtures(sport, league, { traceId, leagueDisplayName: name });
        const count = Array.isArray(fx) ? fx.length : 0;
        afSuccess++;
        afFixturesWarmed += count;
        logger.debug('Warmed API-Football shared cache for league', { traceId, sport, league, count });
      } catch (err2) {
        afError++;
        logger.error('Failed to warm API-Football shared cache for league', {
          traceId,
          sport,
          league,
          error: err2.message
        });
      }
    }
  });
  
  await Promise.all(refreshPromises);
  
  logger.info('Automated stats refresh complete', {
    traceId,
    espn: { successCount, errorCount },
    apiFootball: { afSuccess, afError, afFixturesWarmed },
    sportsCovered: Array.from(sportSet)
  });
});

// Performance Monitoring Endpoint
app.get('/api/monitoring/performance', (req, res) => {
  const stats = {
    cacheSize: cache.size,
    predictionCacheSize: predictionCache.size,
    sportsDataCacheSize: sportsData.cacheSize(),
    providers: sportsData.getProvidersStatus(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  };
  res.json(stats);
});

// Basic route
app.get('/', (req, res) => {
  res.send('Apex API is running');
});

app.get('/api/monitoring/accuracy', (req, res) => {
  const metaPath = path.join(__dirname, 'prediction_engine', 'models', 'winning_model.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const accuracy = meta.precision || 0;
      const status = accuracy >= 0.85 ? 'HEALTHY' : 'ALERT';
      
      if (status === 'ALERT') {
         logger.warn('PREDICTION ACCURACY DROP ALERT', { accuracy, threshold: 0.85 });
      }
      
      res.json({ accuracy, status, lastUpdated: meta.updated_at });
    } catch (err) {
      logger.error('Error parsing model metadata', { error: err.message });
      res.status(500).json({ error: 'Failed to parse model metadata' });
    }
  } else {
    res.status(404).json({ error: 'No model metadata found' });
  }
});

app.post('/api/feedback/correction', async (req, res) => {
  const { matchId, actualOutcome, predictedOutcome, traceId } = req.body;
  logger.info('User feedback received for retraining loop', { matchId, actualOutcome, predictedOutcome });
  
  // Store feedback for next nightly retraining batch
  const feedbackPath = path.join(__dirname, 'prediction_engine', 'feedback_loop.jsonl');
  const entry = JSON.stringify({ matchId, actualOutcome, predictedOutcome, timestamp: new Date() }) + '\n';
  fs.appendFileSync(feedbackPath, entry);
  
  res.json({ success: true, message: 'Feedback recorded for model improvement' });
});

const { spawn } = require('child_process');

app.post('/api/predict', (req, res) => {
  const { traceId } = req;
  const { teamId, sport, league } = req.body;
  
  logger.info('Prediction request received', { traceId, teamId, sport, league });
  
  const pythonProcess = spawn('python', [
    path.join(__dirname, 'prediction_engine', 'main.py')
  ]);

  let dataString = '';
  
  // Send input to Python
  pythonProcess.stdin.write(JSON.stringify({ teamId, sport, league }));
  pythonProcess.stdin.end();

  pythonProcess.stdout.on('data', (data) => {
    dataString += data.toString();
  });

  pythonProcess.stdout.on('end', () => {
    try {
      const result = JSON.parse(dataString);
      logger.info('Prediction generated successfully', { traceId, result });
      res.json({ ...result, traceId });
    } catch (e) {
      logger.error('Error parsing prediction result', { traceId, error: e.message, output: dataString });
      res.status(500).json({ error: 'Prediction engine error', traceId });
    }
  });

  pythonProcess.stderr.on('data', (data) => {
    logger.error('Prediction engine stderr', { traceId, error: data.toString() });
  });
});

// ----------------------------------------------------------
// SERVER-SIDE MATCH PREDICTION ENGINE
// Ported from frontend/utils/predictionLogic.js — pure Node.js,
// no React/COLORS imports. Colors are inlined as hex strings.
// ----------------------------------------------------------

/**
 * Parse a record string like "10-5-2" or "10-5" into win/loss/draw counts.
 * @param {string} record
 * @param {string} sport
 */
function parseRecord(record, sport) {
  if (!record) return { w: 0, l: 0, d: 0, played: 0, winPct: 0 };
  const parts = record.split(/[-–]/).map(s => parseInt(s, 10));
  let w = 0, l = 0, d = 0;
  if (sport === 'basketball' && parts.length >= 2) {
    w = parts[0]; l = parts[1];
  } else if (parts.length === 3) {
    w = parts[0]; d = parts[1]; l = parts[2];
  } else if (parts.length === 2) {
    w = parts[0]; l = parts[1];
  }
  const played = w + l + d;
  return { w, l, d, played, winPct: played ? (w / played) * 100 : 0 };
}

/**
 * Core server-side prediction algorithm.
 * Mirrors frontend/utils/predictionLogic.js analyzeMatch() exactly.
 *
 * @param {Object} params
 * @param {string} params.homeName
 * @param {string} params.awayName
 * @param {Object} params.homeStats  - { record, lastMatches, news, form }
 * @param {Object} params.awayStats  - { record, lastMatches, news, form }
 * @param {Object|null} params.h2h   - { homeWins, awayWins, draws, recent, deepStats }
 * @param {string} params.sport      - 'soccer' | 'basketball'
 * @param {boolean} params.isDetailed
 * @returns {Object} prediction result
 */
function analyzeMatchServer({
  homeName,
  awayName,
  homeStats,
  awayStats,
  h2h = null,
  sport,
  isDetailed = true,
}) {
  // Colour palette (hex, no React dependency)
  const COLORS = {
    success: '#40c057',
    error: '#ff6b6b',
    warning: '#ffa94d',
    info: '#4dabf7',
    textSecondary: '#868e96',
    accent: '#ffd43b',
  };

  const factors = [];
  let homeScore = 0;
  let awayScore = 0;

  // Team Totals
  let homeTeamTotalPrediction = null;
  let homeTeamTotalConfidence = 0;
  let awayTeamTotalPrediction = null;
  let awayTeamTotalConfidence = 0;
  let cornersPrediction = null;
  let cornersConfidence = 0;

  // Football predictions array for the 4 approved markets
  const footballPredictions = [];

  const homeRecord = parseRecord(homeStats.record, sport);
  const awayRecord = parseRecord(awayStats.record, sport);

  // --- 1. Team Strength (Base on Record) --- Weight: 35%
  const recordWeight = 35;
  if (homeRecord.winPct > awayRecord.winPct + 15) {
    homeScore += recordWeight;
    factors.push({ label: 'Better Season Record', side: 'home', type: 'success' });
  } else if (awayRecord.winPct > homeRecord.winPct + 15) {
    awayScore += recordWeight;
    factors.push({ label: 'Better Season Record', side: 'away', type: 'success' });
  }

  // --- 2. Form Analysis (Last 5 matches) ---
  let homeFormPts = 0;
  let awayFormPts = 0;
  let hasForm = false;

  if (homeStats.lastMatches && awayStats.lastMatches) {
    const getFormPoints = (matches) => {
      if (!matches) return 0;
      return matches.reduce(
        (acc, m) => acc + (m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0),
        0
      );
    };
    homeFormPts = getFormPoints(homeStats.lastMatches);
    awayFormPts = getFormPoints(awayStats.lastMatches);
    hasForm = true;
  } else if (homeStats.form && awayStats.form) {
    const parseStreak = (s) => {
      if (!s) return 0;
      const type = s.charAt(0);
      const count = parseInt(s.substring(1)) || 1;
      if (type === 'W') return count * 3;
      if (type === 'D') return count * 1;
      return 0;
    };
    homeFormPts = parseStreak(homeStats.form);
    awayFormPts = parseStreak(awayStats.form);
    hasForm = true;
  }

  if (hasForm) {
    if (homeFormPts > awayFormPts + 3) {
      homeScore += 20;
      factors.push({ label: 'Stronger Recent Form', side: 'home', type: 'success' });
    } else if (awayFormPts > homeFormPts + 3) {
      awayScore += 20;
      factors.push({ label: 'Stronger Recent Form', side: 'away', type: 'success' });
    } else {
      factors.push({ label: 'Competitive Recent Form', side: 'neutral', type: 'info' });
    }

    const processDetails = (matches, side) => {
      if (!matches || matches.length === 0) return;
      const last3 = matches.slice(0, 3);
      if (sport === 'soccer') {
        const cleanSheets = last3.filter(m => m.pa === 0).length;
        if (cleanSheets >= 2) {
          side === 'home' ? (homeScore += 10) : (awayScore += 10);
          factors.push({ label: `Solid Defense (${cleanSheets} Clean Sheets)`, side, type: 'success' });
        }
        const failedToScore = matches.filter(m => m.pf === 0).length;
        if (failedToScore >= 2) {
          side === 'home' ? (homeScore -= 10) : (awayScore -= 10);
          factors.push({ label: 'Struggling to Score', side, type: 'error' });
        }
      }
    };

    if (isDetailed) {
      processDetails(homeStats.lastMatches, 'home');
      processDetails(awayStats.lastMatches, 'away');

      const getTrend = (matches) => {
        if (!matches || matches.length < 3) return 0;
        const p = (m) => (m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0);
        return (p(matches[0]) + p(matches[1])) - (p(matches[2]) + (matches[3] ? p(matches[3]) : 1));
      };

      const hTrend = getTrend(homeStats.lastMatches);
      const aTrend = getTrend(awayStats.lastMatches);

      if (hTrend > aTrend + 1) {
        homeScore += 5;
        factors.push({ label: 'Upward Performance Trend', side: 'home', type: 'success' });
      } else if (aTrend > hTrend + 1) {
        awayScore += 5;
        factors.push({ label: 'Upward Performance Trend', side: 'away', type: 'success' });
      }
    }
  }

  // --- 3. Head to Head ---
  let h2hAvgGoals = 0;
  let h2hMaxPoints = 0;
  let h2hMinPoints = 1000;

  if (h2h) {
    const totalMeetings = h2h.homeWins + h2h.awayWins + h2h.draws;
    if (totalMeetings > 0) {
      const hWinPct = (h2h.homeWins / totalMeetings) * 100;
      const aWinPct = (h2h.awayWins / totalMeetings) * 100;
      if (hWinPct > 50) {
        homeScore += 15;
        factors.push({ label: 'Dominates H2H', side: 'home', type: 'success' });
      } else if (aWinPct > 50) {
        awayScore += 15;
        factors.push({ label: 'Dominates H2H', side: 'away', type: 'success' });
      }
    }

    if (h2h.recent && h2h.recent.length > 0) {
      let totalGoals = 0;
      let validGames = 0;
      h2h.recent.forEach(game => {
        if (game.score && game.score.includes('-')) {
          const parts = game.score.split('-').map(s => parseInt(s, 10));
          if (!isNaN(parts[0]) && !isNaN(parts[1])) {
            const gameTotal = parts[0] + parts[1];
            totalGoals += gameTotal;
            if (gameTotal > h2hMaxPoints) h2hMaxPoints = gameTotal;
            if (gameTotal < h2hMinPoints) h2hMinPoints = gameTotal;
            validGames++;
          }
        }
      });
      if (validGames > 0) {
        h2hAvgGoals = totalGoals / validGames;
        const label = sport === 'basketball' ? 'Points' : 'Goals';
        if (sport !== 'basketball') {
          if (h2hAvgGoals > 2.8)
            factors.push({ label: `H2H Avg > 2.8 ${label}`, side: 'neutral', type: 'info' });
          else if (h2hAvgGoals < 1.8)
            factors.push({ label: `H2H Avg < 1.8 ${label}`, side: 'neutral', type: 'info' });
        } else {
          if (h2hAvgGoals > 225)
            factors.push({ label: `H2H Avg > 225 ${label}`, side: 'neutral', type: 'info' });
        }
      }
    }

    if (h2h.deepStats && sport === 'soccer') {
      const totals = [];
      let maxCorners = 0;
      let minCorners = 1000;
      h2h.deepStats.forEach(game => {
        const homeCorners = game?.homeStats?.corners || 0;
        const awayCorners = game?.awayStats?.corners || 0;
        const total = homeCorners + awayCorners;
        if (total > 0) {
          totals.push(total);
          if (total > maxCorners) maxCorners = total;
          if (total < minCorners) minCorners = total;
        }
      });
      if (totals.length > 0) {
        const sum = totals.reduce((a, b) => a + b, 0);
        const avgCorners = sum / totals.length;
        const line = FOOTBALL_UNDER_CORNERS_LINE;
        const diffFromLine = avgCorners - line;
        const baseConfidence = 65;
        const strengthBoost = Math.min(Math.abs(diffFromLine) * 10, 25);
        cornersPrediction = `Under ${line} Corners`;
        cornersConfidence = diffFromLine <= 0
          ? Math.min(baseConfidence + strengthBoost, 95)
          : Math.max(baseConfidence - strengthBoost, 30);
        factors.push({ label: `H2H Avg Corners ${avgCorners.toFixed(1)}`, side: 'neutral', type: 'info' });

        // Add Under Corners prediction to footballPredictions array
        if (cornersConfidence >= 50) {
          footballPredictions.push({
            market: 'under_corners',
            label: `Under ${line} Corners`,
            value: `Under ${line} Total Corners`,
            confidence: Math.round(cornersConfidence),
            color: cornersConfidence >= 70 ? '#40c057' : cornersConfidence >= 60 ? '#ffa94d' : '#4dabf7',
          });
        }
      }
    }
  }

  // --- 4. Goal / Points Analysis ---
  let hAvgScored = 0, aAvgScored = 0;
  let hAvgConceded = 0, aAvgConceded = 0;
  let hLastGamePts = 0, aLastGamePts = 0;

  if (homeStats.lastMatches && awayStats.lastMatches) {
    const calcAvg = (matches, key) =>
      matches.reduce((sum, m) => sum + (m[key] || 0), 0) / matches.length;
    hAvgScored = calcAvg(homeStats.lastMatches, 'pf');
    aAvgScored = calcAvg(awayStats.lastMatches, 'pf');
    hAvgConceded = calcAvg(homeStats.lastMatches, 'pa');
    aAvgConceded = calcAvg(awayStats.lastMatches, 'pa');

    if (homeStats.lastMatches.length > 0) {
      const last = homeStats.lastMatches[0];
      hLastGamePts = (parseFloat(last.pf) || 0) + (parseFloat(last.pa) || 0);
    }
    if (awayStats.lastMatches.length > 0) {
      const last = awayStats.lastMatches[0];
      aLastGamePts = (parseFloat(last.pf) || 0) + (parseFloat(last.pa) || 0);
    }
  }

  if (hAvgScored > 0 && aAvgScored > 0) {
    if (hAvgScored > aAvgScored + 0.5) {
      homeScore += 15;
      factors.push({ label: `High Scoring (${hAvgScored.toFixed(1)} avg)`, side: 'home', type: 'info' });
    } else if (aAvgScored > hAvgScored + 0.5) {
      awayScore += 15;
      factors.push({ label: `High Scoring (${aAvgScored.toFixed(1)} avg)`, side: 'away', type: 'info' });
    }
  }

  // --- 5. News / Injuries ---
  if (homeStats.news && awayStats.news) {
    const checkNews = (news) => {
      if (!news) return false;
      const keywords = ['injury', 'injured', 'out', 'miss', 'suspended', 'surgery'];
      return news.some(n =>
        keywords.some(
          k =>
            n.headline.toLowerCase().includes(k) ||
            (n.description && n.description.toLowerCase().includes(k))
        )
      );
    };
    if (checkNews(homeStats.news)) {
      homeScore -= 15;
      factors.push({ label: 'Roster Issues', side: 'home', type: 'error' });
    }
    if (checkNews(awayStats.news)) {
      awayScore -= 15;
      factors.push({ label: 'Roster Issues', side: 'away', type: 'error' });
    }
  }

  // --- FINAL PREDICTION LOGIC ---
  const diff = homeScore - awayScore;
  const isBasketball = sport === 'basketball';

  let winPrediction = null;
  let winConfidence = 0;

  if (diff > 12) {
    winPrediction = `${homeName} Win`;
    winConfidence = Math.min(65 + diff, isBasketball ? 95 : 92);
  } else if (diff < -12) {
    winPrediction = `${awayName} Win`;
    winConfidence = Math.min(65 + Math.abs(diff), isBasketball ? 95 : 92);
  } else {
    if (isBasketball) {
      winPrediction = diff > 0 ? `${homeName} Slight Edge` : `${awayName} Slight Edge`;
      winConfidence = 55 + Math.abs(diff);
    } else {
      if (diff > 5) { winPrediction = '1X (Home Win or Draw)'; winConfidence = 65; }
      else if (diff < -5) { winPrediction = 'X2 (Away Win or Draw)'; winConfidence = 65; }
      else { winPrediction = 'Competitive / Draw Potential'; winConfidence = 55; }
    }
  }

  // B. Goals / Totals
  let goalsPrediction = null;
  let goalsConfidence = 0;
  let projectedTotalPoints = 0;
  let projectedMargin = 0;

  if (hAvgScored > 0 && aAvgScored > 0) {
    if (!isBasketball) {
      let expHomeGoals = (hAvgScored + aAvgConceded) / 2;
      let expAwayGoals = (aAvgScored + hAvgConceded) / 2;
      let totalExpGoals = expHomeGoals + expAwayGoals;

      if (h2hAvgGoals > 0) {
        totalExpGoals = totalExpGoals * 0.7 + h2hAvgGoals * 0.3;
      }

      // Generate Under 4.5 Goals prediction for football
      const uf45Threshold = 4.5;
      if (totalExpGoals < uf45Threshold - 0.35) {
        const uf45Confidence = Math.min(60 + (uf45Threshold - totalExpGoals) * 30, 95);
        if (uf45Confidence >= 50) {
          footballPredictions.push({
            market: 'under_4_5_goals',
            label: 'Under 4.5 Goals',
            value: 'Under 4.5 Full-Time Goals',
            confidence: uf45Confidence,
            color: uf45Confidence >= 70 ? '#40c057' : uf45Confidence >= 60 ? '#ffa94d' : '#4dabf7',
          });
        }
      }

      if (totalExpGoals > 2.8)
        factors.push({ label: `High Goal Expectancy (${totalExpGoals.toFixed(1)})`, side: 'neutral', type: 'success' });
      else if (totalExpGoals < 2.2)
        factors.push({ label: `Low Goal Expectancy (${totalExpGoals.toFixed(1)})`, side: 'neutral', type: 'warning' });
    } else {
      // Basketball totals
      let homeExp = (hAvgScored + aAvgConceded) / 2;
      let awayExp = (aAvgScored + hAvgConceded) / 2;
      let totalPoints = homeExp + awayExp;
      if (h2hAvgGoals > 0) totalPoints = totalPoints * 0.7 + h2hAvgGoals * 0.3;
      if (hLastGamePts > 0 && aLastGamePts > 0) {
        const recentTrend = (hLastGamePts + aLastGamePts) / 2;
        totalPoints = totalPoints * 0.8 + recentTrend * 0.2;
      }
      projectedTotalPoints = totalPoints;

      const predictedLine = Math.round(totalPoints);
      let confidenceBoost = 0;
      if (h2hAvgGoals > 0) {
        if (h2hMinPoints > predictedLine - 10) { confidenceBoost += 5; factors.push({ label: `H2H Floor High (> ${h2hMinPoints})`, side: 'neutral', type: 'info' }); }
        if (h2hMaxPoints < predictedLine + 10) { confidenceBoost += 5; factors.push({ label: `H2H Ceiling Low (< ${h2hMaxPoints})`, side: 'neutral', type: 'info' }); }
      }
      if (hLastGamePts > 0) {
        if (hLastGamePts > predictedLine / 2 + 10) factors.push({ label: `${homeName} Last Game High (${hLastGamePts})`, side: 'home', type: 'info' });
        else if (hLastGamePts < predictedLine / 2 - 10) factors.push({ label: `${homeName} Last Game Low (${hLastGamePts})`, side: 'home', type: 'info' });
      }

      const margin = Math.max(5, Math.round(projectedTotalPoints * 0.035));
      const overLine = Math.floor(projectedTotalPoints - margin) + 0.5;
      const underLine = Math.ceil(projectedTotalPoints + margin) - 0.5;

      let preferUnder = false;
      let reasonForUnder = '';
      let underConfidenceBoost = 0;
      const recentTrend = (hLastGamePts + aLastGamePts) / 2;

      if (h2hAvgGoals > 0 && h2hAvgGoals < projectedTotalPoints - 8) { preferUnder = true; reasonForUnder = 'H2H Low'; underConfidenceBoost += 5; }
      if (hLastGamePts > 0 && aLastGamePts > 0 && recentTrend < projectedTotalPoints - 10) { preferUnder = true; reasonForUnder = reasonForUnder ? reasonForUnder + ' & Recent Low' : 'Recent Games Low'; underConfidenceBoost += 5; }
      if (projectedTotalPoints < 210) { preferUnder = true; reasonForUnder = reasonForUnder ? reasonForUnder + ' & Low Proj' : 'Defensive Matchup'; underConfidenceBoost += 5; }

      if (preferUnder) {
        goalsPrediction = `Under ${underLine}`;
        goalsConfidence = 65 + confidenceBoost + underConfidenceBoost;
        factors.push({ label: `Trend: Low Scoring (${reasonForUnder})`, side: 'neutral', type: 'warning' });
      } else {
        goalsPrediction = `Over ${overLine}`;
        goalsConfidence = 68 + confidenceBoost;
        factors.push({ label: `Proj. Total ${predictedLine} Pts`, side: 'neutral', type: 'success' });
      }
    }
  }

  // --- Basketball Spread ---
  let spreadPrediction = null;
  let spreadConfidence = 0;

  if (isBasketball && homeStats.lastMatches && awayStats.lastMatches) {
    const getMargin = (matches) => {
      if (!matches || matches.length === 0) return 0;
      return matches.reduce((sum, m) => sum + (parseInt(m.pf) - parseInt(m.pa)), 0) / matches.length;
    };
    const homeAtHome = homeStats.lastMatches.filter(m => m.isHome);
    const awayAtAway = awayStats.lastMatches.filter(m => !m.isHome);
    const homeRating = homeAtHome.length >= 2 ? getMargin(homeAtHome) : getMargin(homeStats.lastMatches) + 3;
    const awayRating = awayAtAway.length >= 2 ? getMargin(awayAtAway) : getMargin(awayStats.lastMatches) - 3;
    projectedMargin = homeRating - awayRating;

    const checkFatigue = (matches) => {
      if (!matches || matches.length === 0) return false;
      const lastDate = new Date(matches[0].date);
      const today = new Date();
      const diffDays = Math.ceil(Math.abs(today - lastDate) / (1000 * 60 * 60 * 24));
      return diffDays <= 2;
    };

    if (checkFatigue(homeStats.lastMatches)) { projectedMargin -= 4; factors.push({ label: 'Home Fatigue (Short Rest)', side: 'away', type: 'warning' }); }
    if (checkFatigue(awayStats.lastMatches)) { projectedMargin += 4; factors.push({ label: 'Away Fatigue (Short Rest)', side: 'home', type: 'success' }); }

    if (h2h && h2h.homeWins !== undefined) {
      const total = h2h.homeWins + h2h.awayWins;
      if (total > 0) {
        if (h2h.homeWins / total > 0.6) projectedMargin += 3;
        if (h2h.awayWins / total > 0.6) projectedMargin -= 3;
      }
    }
  }

  // --- C. Football Half-Time Goals Predictions (Soccer only) ---
  //
  // ESPN does not expose 1st-half splits, so we estimate them from full-match
  // averages via a FIRST_HALF_GOAL_RATIO (empirically ~40% of goals in top EU leagues).
  //
  // Algorithm for Under X goals:
  //   homeHalfLambda = ((homeAvgScored + awayAvgConceded) / 2) * RATIO
  //   awayHalfLambda = ((awayAvgScored + homeAvgConceded) / 2) * RATIO
  //   totalLambda    = homeHalfLambda + awayHalfLambda
  //   P(under X)     = sum(Poisson(k, totalLambda) for k in 0..X-1)
  //   confidence     = clamp(P * 100, 30, 95)
  //
  // Adjustments applied on top of the base Poisson confidence:
  //   +5%  both teams have ≥ 2 clean sheets in last 5
  //   +5%  H2H average goals < 1.5
  //   -8%  either team averages > 2.0 full-match goals scored

  // NOTE: footballPredictions is declared earlier (line ~514) and is the single
  // authoritative array for all four approved markets. Do not re-declare here.

  if (!isBasketball && hAvgScored > 0 && aAvgScored > 0) {
    const FIRST_HALF_GOAL_RATIO = 0.40; // ~40 % of goals occur in the first half

    // Expected 1st-half goals for each side (Dixon-Coles style blended estimate)
    const homeHalfLambda =
      ((hAvgScored * FIRST_HALF_GOAL_RATIO) + (aAvgConceded * FIRST_HALF_GOAL_RATIO)) / 2;
    const awayHalfLambda =
      ((aAvgScored * FIRST_HALF_GOAL_RATIO) + (hAvgConceded * FIRST_HALF_GOAL_RATIO)) / 2;
    const totalLambda = homeHalfLambda + awayHalfLambda;

    // Poisson probability function
    const poissonPmf = (k, lambda) => {
      return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
    };

    const factorial = (n) => {
      if (n <= 1) return 1;
      let result = 1;
      for (let i = 2; i <= n; i++) result *= i;
      return result;
    };

    // Calculate P(under X) = sum of P(0) to P(X-1)
    const calculateUnderProbability = (threshold, lambda) => {
      let prob = 0;
      for (let k = 0; k < threshold; k++) {
        prob += poissonPmf(k, lambda);
      }
      return prob;
    };

    // Base confidence calculation
    const calculateBaseConfidence = (threshold) => {
      const prob = calculateUnderProbability(threshold, totalLambda);
      let confidence = Math.round(prob * 100);

      // --- Adjustments ---

      // Defensive bonus: count clean sheets (pa === 0) in last 5 for each team
      const homeCleanSheets = homeStats.lastMatches
        ? homeStats.lastMatches.filter(m => m.pa === 0).length
        : 0;
      const awayCleanSheets = awayStats.lastMatches
        ? awayStats.lastMatches.filter(m => m.pa === 0).length
        : 0;
      if (homeCleanSheets >= 2 && awayCleanSheets >= 2) {
        confidence += 5;
        if (threshold === 1.5) {
          factors.push({ label: 'Both Teams Defensively Solid (HT indicator)', side: 'neutral', type: 'info' });
        }
      } else if (homeCleanSheets >= 2 || awayCleanSheets >= 2) {
        confidence += 3;
      }

      // H2H low-scoring bonus
      if (h2hAvgGoals > 0 && h2hAvgGoals < 1.5) {
        confidence += 5;
      }

      // High-scoring teams penalty
      if (hAvgScored > 2.0 || aAvgScored > 2.0) {
        confidence -= 8;
        if (threshold === 1.5) {
          factors.push({ label: 'High-Scoring Team Involved (HT risk)', side: 'neutral', type: 'warning' });
        }
      }

      // Clamp to a realistic range
      return Math.min(Math.max(confidence, 30), 95);
    };

    // Generate Under 1.5 HT prediction
    const uh15Confidence = calculateBaseConfidence(1.5);
    if (uh15Confidence >= 50) {
      footballPredictions.push({
        market: 'under_1_5_ht',
        label: 'Under 1.5 HT',
        value: 'Under 1.5 First-Half Goals',
        confidence: uh15Confidence,
        color: uh15Confidence >= 70 ? '#40c057' : uh15Confidence >= 60 ? '#ffa94d' : '#4dabf7',
      });
    }

    // Generate Under 2.5 HT prediction
    const uh25Confidence = calculateBaseConfidence(2.5);
    if (uh25Confidence >= 50) {
      footballPredictions.push({
        market: 'under_2_5_ht',
        label: 'Under 2.5 HT',
        value: 'Under 2.5 First-Half Goals',
        confidence: uh25Confidence,
        color: uh25Confidence >= 70 ? '#40c057' : uh25Confidence >= 60 ? '#ffa94d' : '#4dabf7',
      });
    }
  }

  // --- Recommendations ---
  // Soccer: Top 2 highest-confidence predictions from the 4 approved markets
  //         (under_corners, under_4_5_goals, under_1_5_ht, under_2_5_ht)
  // Basketball: WIN + GOALS/Totals retained as before.
  const recommendations = [];

  if (isBasketball) {
    // Basketball — keep Match Winner and Total Points
    if (winPrediction) {
      recommendations.push({
        type: 'WIN',
        label: 'Match Winner',
        value: winPrediction,
        confidence: Math.round(winConfidence),
        color: diff > 0 ? '#40c057' : (diff < 0 ? '#ff6b6b' : '#868e96'),
      });
    }
    if (goalsPrediction) {
      recommendations.push({
        type: 'GOALS',
        label: 'Total Points',
        value: goalsPrediction,
        confidence: Math.round(goalsConfidence),
        color: '#ffd43b',
      });
    }
  } else if (sport === 'tennis') {
    // Tennis — keep Match Winner
    if (winPrediction) {
      recommendations.push({
        type: 'WIN',
        label: 'Match Winner',
        value: winPrediction,
        confidence: Math.round(winConfidence),
        color: diff > 0 ? '#40c057' : (diff < 0 ? '#ff6b6b' : '#868e96'),
      });
    }
  } else {
    // Soccer — delegate top-2 selection to the shared ranking utility.
    // rankFootballPredictions validates, deduplicates, sorts by confidence
    // (descending), and applies deterministic tie-breaking. Returns at most 2.
    const topPredictions = rankFootballPredictions(footballPredictions);

    // Add to recommendations with proper type
    topPredictions.forEach(pred => {
      recommendations.push({
        type: pred.market.toUpperCase(),
        label: pred.label,
        value: pred.value,
        confidence: Math.round(pred.confidence),
        color: pred.color,
      });
    });
  }

  return {
    prediction: recommendations.length > 0 ? recommendations[0].value : 'Too Close to Call',
    confidence: recommendations.length > 0 ? recommendations[0].confidence : 45,
    color: recommendations.length > 0 ? recommendations[0].color : '#868e96',
    recommendations,
    factors,
  };
}

// Prediction result cache (separate from ESPN proxy cache)
const predictionCache = new Map();
const PREDICTION_TTL_MS = 2 * 60 * 1000; // 2 minutes

function getPredictionFromCache(key) {
  const item = predictionCache.get(key);
  if (!item) return null;
  if (item.expiresAt < Date.now()) { predictionCache.delete(key); return null; }
  return item.data;
}

function setPredictionCache(key, data) {
  predictionCache.set(key, { data, expiresAt: Date.now() + PREDICTION_TTL_MS });
}

/**
 * Validate sport slug — must be one of the known ESPN sport identifiers.
 */
const VALID_SPORTS = new Set(['soccer', 'basketball', 'tennis']);

/**
 * Validate league slug — alphanumeric, dots, hyphens only, max 40 chars.
 */
function isValidLeagueSlug(slug) {
  return typeof slug === 'string' && /^[a-zA-Z0-9.\-]{1,40}$/.test(slug);
}

/**
 * Validate a team/match ID — ESPN/AF digits or PitchAPI tokens (e.g. pa-m_B8x2K9, pa-t_9aB2xQ).
 */
function isValidId(id) {
  return typeof id === 'string' && (
    /^(af-)?\d{1,15}$/.test(id) ||
    /^(pa-)?[a-z]_[a-zA-Z0-9]{4,12}$/.test(id)
  );
}

/**
 * Helper: Process ESPN schedule events into the lastMatches format
 * expected by analyzeMatchServer.
 */
function processScheduleForTeam(events, teamId) {
  const validEvents = events.filter(e => {
    const state = e.competitions?.[0]?.status?.type?.state;
    return state === 'post' || state === 'in';
  });
  const last5 = validEvents.slice(-5).reverse();

  return last5.map(event => {
    const competition = event.competitions?.[0];
    if (!competition) return null;
    const teamComp = competition.competitors?.find(c => String(c?.team?.id) === String(teamId));
    const oppComp = competition.competitors?.find(c => String(c?.team?.id) !== String(teamId));
    if (!teamComp || !oppComp) return null;

    const teamScore = parseInt(teamComp.score?.value || 0);
    const oppScore = parseInt(oppComp.score?.value || 0);
    const state = competition.status?.type?.state;

    let result;
    if (state === 'in') result = 'D';
    else if (teamScore > oppScore) result = 'W';
    else if (teamScore < oppScore) result = 'L';
    else result = 'D';

    return {
      date: event.date,
      pf: teamScore,
      pa: oppScore,
      isHome: teamComp?.homeAway === 'home',
      result,
      opponentId: oppComp?.team?.id,
    };
  }).filter(Boolean);
}

/**
 * Helper: Build H2H object from headToHeadGames (ESPN summary data).
 */
function buildH2H(headToHeadGames, matchId, homeTeamId, awayTeamId) {
  if (!headToHeadGames || headToHeadGames.length === 0) return null;

  const validH2H = headToHeadGames.filter(
    g =>
      String(g.id) !== String(matchId) &&
      g.homeTeamScore !== undefined &&
      g.awayTeamScore !== undefined
  );

  if (validH2H.length === 0) return null;

  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;

  const recent = validH2H.slice(0, 5).map(game => {
    const hScore = parseInt(game.homeTeamScore || 0);
    const aScore = parseInt(game.awayTeamScore || 0);
    const isCurrentHomeHosting = String(game.homeTeamId) === String(homeTeamId);

    if (hScore === aScore) draws++;
    else if (isCurrentHomeHosting) {
      if (hScore > aScore) homeWins++;
      else awayWins++;
    } else {
      if (aScore > hScore) homeWins++;
      else awayWins++;
    }

    return {
      date: game.gameDate,
      score: game.score ? game.score.replace(/\s/g, '') : '?-?',
      id: game.id,
    };
  });

  return { homeWins, awayWins, draws, recent };
}

/**
 * POST /api/match-prediction
 *
 * Body: { matchId, sport, leagueSlug, homeTeamId, awayTeamId }
 *
 * Fetches all required ESPN data server-side, runs the full prediction
 * algorithm, caches the result for 2 minutes, and returns structured
 * prediction output to the frontend.
 */
app.post('/api/match-prediction', async (req, res) => {
  const { traceId } = req;

  // --- Input Validation ---
  const { matchId, sport, leagueSlug, homeTeamId, awayTeamId } = req.body || {};

  if (!matchId || !sport || !leagueSlug || !homeTeamId || !awayTeamId) {
    return res.status(400).json({
      error: 'Missing required fields: matchId, sport, leagueSlug, homeTeamId, awayTeamId',
      traceId,
    });
  }

  if (!VALID_SPORTS.has(sport)) {
    return res.status(400).json({
      error: `Invalid sport "${sport}". Must be one of: soccer, basketball, tennis`,
      traceId,
    });
  }

  if (!isValidLeagueSlug(leagueSlug)) {
    return res.status(400).json({
      error: 'Invalid leagueSlug format. Alphanumeric, dots and hyphens only, max 40 chars.',
      traceId,
    });
  }

  if (!isValidId(String(matchId)) || !isValidId(String(homeTeamId)) || !isValidId(String(awayTeamId))) {
    return res.status(400).json({
      error: 'Invalid matchId, homeTeamId, or awayTeamId. Must be numeric strings.',
      traceId,
    });
  }

  const cacheKey = `prediction:${sport}:${leagueSlug}:${matchId}`;

  // --- Serve from cache if available ---
  const cached = getPredictionFromCache(cacheKey);
  if (cached) {
    logger.info('Prediction served from cache', { traceId, cacheKey });
    return res.json({ ...cached, traceId, fromCache: true });
  }

  logger.info('Match prediction requested', { traceId, matchId, sport, leagueSlug, homeTeamId, awayTeamId });

  // --- Unified prediction data ---
  // Primary: Direct ESPN fetch (preserves 100% existing behavior)
  // Fallback: SportsDataService (ESPN → API-Football chain, normalized)
  let homeName, awayName, homeRecord, awayRecord;
  let homeLastMatches = [];
  let awayLastMatches = [];
  let homeNews = [];
  let awayNews = [];
  let h2h = null;
  let dataSource = 'espn-direct';
  let dataTried = ['espn-direct'];

  let espnSufficient = false;
  try {
    const [homeTeamData, awayTeamData, matchAnalysisData, homeScheduleData, awayScheduleData, homeNewsData, awayNewsData] =
      await Promise.all([
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/teams/${homeTeamId}`),
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/teams/${awayTeamId}`),
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/summary?event=${matchId}`),
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/teams/${homeTeamId}/schedule`),
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/teams/${awayTeamId}/schedule`),
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/news?team=${homeTeamId}&limit=5`),
        fetchFromBackendOrESPN(`${sport}/${leagueSlug}/news?team=${awayTeamId}&limit=5`),
      ]);

    const homeTeam = homeTeamData?.team;
    const awayTeam = awayTeamData?.team;

    homeName = homeTeam?.displayName || `Team ${homeTeamId}`;
    awayName = awayTeam?.displayName || `Team ${awayTeamId}`;
    homeRecord = homeTeam?.record?.items?.[0]?.summary;
    awayRecord = awayTeam?.record?.items?.[0]?.summary;

    homeLastMatches = processScheduleForTeam(homeScheduleData?.events || [], homeTeamId);
    awayLastMatches = processScheduleForTeam(awayScheduleData?.events || [], awayTeamId);

    homeNews = (homeNewsData?.articles || []).map(a => ({
      headline: a.headline || '',
      description: a.description || '',
    }));
    awayNews = (awayNewsData?.articles || []).map(a => ({
      headline: a.headline || '',
      description: a.description || '',
    }));

    let rawH2H = matchAnalysisData?.headToHeadGames || [];
    if (rawH2H.length > 0 && rawH2H[0]?.events) {
      rawH2H = rawH2H.flatMap(item => item.events || []);
      rawH2H = [...new Map(rawH2H.map(item => [item.id, item])).values()];
    }
    h2h = buildH2H(rawH2H, matchId, homeTeamId, awayTeamId);

    espnSufficient = Boolean(
      (homeTeam?.displayName || awayTeam?.displayName) &&
      (homeLastMatches.length > 0 || awayLastMatches.length > 0 || h2h)
    );
  } catch (espnError) {
    logger.warn('ESPN direct fetch/parse failed, attempting SportsDataService fallback', {
      traceId, matchId, sport, leagueSlug, error: espnError.message,
    });
    espnSufficient = false;
  }

  if (!espnSufficient) {
    logger.info('[SPORTS DATA] ESPN → data insufficient, attempting fallback', { traceId, matchId });
    const sds = await sportsData.getMatchDataForPrediction({
      matchId, sport, leagueSlug, homeTeamId, awayTeamId, traceId,
    });
    dataTried = sds.tried || [];
    if (sds.source) {
      dataSource = sds.source;
      homeName = sds.homeName || homeName;
      awayName = sds.awayName || awayName;
      homeRecord = sds.homeRecord || homeRecord;
      awayRecord = sds.awayRecord || awayRecord;
      homeLastMatches = sds.homeLastMatches && sds.homeLastMatches.length ? sds.homeLastMatches : homeLastMatches;
      awayLastMatches = sds.awayLastMatches && sds.awayLastMatches.length ? sds.awayLastMatches : awayLastMatches;
      homeNews = sds.homeNewsParsed && sds.homeNewsParsed.length ? sds.homeNewsParsed : homeNews;
      awayNews = sds.awayNewsParsed && sds.awayNewsParsed.length ? sds.awayNewsParsed : awayNews;
      h2h = sds.h2h || h2h;
      logger.info(`[SPORTS DATA] ${sds.source.toUpperCase()} → fallback data used for prediction`, {
        traceId, matchId, source: sds.source,
        homeForm: homeLastMatches.length, awayForm: awayLastMatches.length,
      });
    } else {
      logger.warn('[SPORTS DATA] All providers returned insufficient data', {
        traceId, matchId, tried: dataTried,
      });
      if (!homeName && !awayName) {
        return res.status(502).json({
          error: 'Failed to fetch match data from all available providers. Please try again later.',
          traceId,
          providersTried: dataTried,
        });
      }
    }
  }

  // --- Run Prediction Algorithm ---
  let prediction;
  try {
    prediction = analyzeMatchServer({
      homeName,
      awayName,
      homeStats: {
        record: homeRecord,
        lastMatches: homeLastMatches,
        news: homeNews,
      },
      awayStats: {
        record: awayRecord,
        lastMatches: awayLastMatches,
        news: awayNews,
      },
      h2h,
      sport,
      isDetailed: true,
    });
  } catch (algoError) {
    logger.error('Prediction algorithm error', {
      traceId,
      matchId,
      error: algoError.message,
      stack: algoError.stack,
    });
    return res.status(500).json({
      error: 'Prediction algorithm encountered an unexpected error.',
      traceId,
    });
  }

  // --- Build Response ---
  const result = {
    matchId,
    sport,
    leagueSlug,
    homeName,
    awayName,
    fromCache: false,
    ...prediction,
    meta: {
      homeRecord: homeRecord || 'N/A',
      awayRecord: awayRecord || 'N/A',
      homeFormMatches: homeLastMatches.length,
      awayFormMatches: awayLastMatches.length,
      h2hGamesAnalyzed: h2h ? (h2h.recent?.length || 0) : 0,
      generatedAt: new Date().toISOString(),
      dataSource,
      providersTried: dataTried,
    },
  };

  // Cache the result
  setPredictionCache(cacheKey, result);

  logger.info('Match prediction generated successfully', {
    traceId,
    matchId,
    sport,
    homeName,
    awayName,
    topPrediction: result.prediction,
    confidence: result.confidence,
    dataSource,
  });

  return res.json({ ...result, traceId });
});

// Bulk match predictions endpoint (optimized, with caching)
app.get('/api/match-predictions', async (req, res) => {
    const { traceId } = req;
    const { sport, league } = req.query;
    logger.info('Match predictions request received', { traceId, sport, league });
    
    try {
        // We'll spawn a Python process to use our PredictionEngine
        const args = [
            path.join(__dirname, 'prediction_engine', 'main.py'),
            '--predictions',
            sport,
            league
        ];
        
        const pythonProcess = spawn('python', args);
        
        let dataString = '';
        let errorString = '';
        
        pythonProcess.stdout.on('data', (data) => {
            dataString += data.toString();
        });
        
        pythonProcess.stderr.on('data', (data) => {
            errorString += data.toString();
            logger.error('Prediction engine stderr', { traceId, error: data.toString() });
        });
        
        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                return res.status(500).json({ 
                    error: 'Prediction engine failed', 
                    traceId, 
                    stderr: errorString 
                });
            }
            
            try {
                const result = JSON.parse(dataString);
                res.json({ ...result, traceId });
            } catch (err) {
                logger.error('Error parsing predictions JSON', { 
                    traceId, 
                    error: err.message,
                    output: dataString 
                });
                res.status(500).json({ error: 'Failed to parse predictions', traceId });
            }
        });
        
    } catch (error) {
        logger.error('Error fetching match predictions', {
            traceId,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to fetch match predictions', traceId });
    }
});

// Live games only endpoint — ESPN primary, API-Football fallback (deduplicated)
app.get('/api/live-games', async (req, res) => {
    const { traceId } = req;
    const { sport, league } = req.query;
    logger.info('Live games request received', { traceId, sport, league });

    try {
        if (sport && league) {
            if (!isValidRelativeTarget(`${sport}/${league}`)) {
                return res.status(400).json({ error: 'Invalid sport/league', traceId });
            }

            let espnLive = [];
            try {
                const target = `${sport}/${league}/scoreboard`;
                const scoreboardData = await fetchFromBackendOrESPN(target);
                if (scoreboardData?.events) {
                    espnLive = scoreboardData.events.filter(
                        e => e.competitions?.[0]?.status?.type?.state === 'in'
                    );
                }
            } catch (_) { /* fall through */ }

            if (espnLive.length > 0) {
                return res.json({ liveGames: espnLive, traceId, count: espnLive.length, source: 'espn' });
            }

            if ((sport === 'soccer' || sport === 'football')) {
                const all = await sportsData.getLiveFixtures({
                    traceId,
                    leagueConfigs: [{ sport, league }],
                });
                return res.json({ liveGames: all, traceId, count: all.length, source: 'merged' });
            }

            return res.json({ liveGames: [], traceId });
        }

        const all = await sportsData.getLiveFixtures({ traceId });
        res.json({ liveGames: all, traceId, count: all.length, source: 'merged' });
    } catch (error) {
        logger.error('Error fetching live games', { traceId, error: error.message });
        res.status(500).json({ error: 'Failed to fetch live games', traceId });
    }
});

// Sports data provider status — debugging/monitoring
app.get('/api/sports-data/status', (req, res) => {
    const { traceId } = req;
    res.json({
        traceId,
        providers: sportsData.getProvidersStatus(),
        cache: {
            espnProxySize: cache.size,
            predictionCacheSize: predictionCache.size,
            sharedCacheSize: sportsData.cacheSize(),
        },
    });
});

// Admin /discover endpoint: list football leagues (for soccer/football)
app.get('/api/sports-data/leagues', async (req, res) => {
    const { traceId } = req;
    const { sport = 'soccer', country, season } = req.query;
    const effectiveSeason = (season ? String(season).slice(0, 10) : String(new Date().getFullYear()));
    const effectiveCountry = country ? String(country).slice(0, 60) : null;
    const paAvailable = sportsData.pitchApi && sportsData.pitchApi.isAvailable
        ? sportsData.pitchApi.isAvailable()
        : false;

    if (sport && sport !== 'soccer' && sport !== 'football') {
        const diagnostics = {
            reason: 'sport_not_supported',
            season: effectiveSeason,
            country: effectiveCountry,
            provider: 'pitchapi',
        };
        logger.info('[SPORTS DATA] leagues zero-result', {
            traceId,
            effectiveSeason,
            effectiveCountry,
            reason: diagnostics.reason,
            providerAvailable: paAvailable,
        });
        return res.json({ leagues: [], traceId, count: 0, diagnostics });
    }
    try {
        const opts = { traceId };
        if (effectiveCountry) opts.country = effectiveCountry;
        opts.season = effectiveSeason;
        const leagues = await sportsData.listFootballLeagues(opts);
        const count = Array.isArray(leagues) ? leagues.length : 0;

        if (count === 0) {
            let reason = 'no_data_for_season';
            if (!paAvailable) reason = 'provider_unavailable';
            const diagnostics = {
                reason,
                season: effectiveSeason,
                country: effectiveCountry,
                provider: 'pitchapi',
            };
            logger.info('[SPORTS DATA] leagues zero-result', {
                traceId,
                effectiveSeason,
                effectiveCountry,
                reason,
                providerAvailable: paAvailable,
            });
            res.json({ leagues: [], traceId, count: 0, diagnostics });
        } else {
            res.json({ leagues, traceId, count });
        }
    } catch (error) {
        logger.error('Error listing football leagues', { traceId, error: error.message });
        res.status(500).json({ error: 'Failed to list leagues', traceId });
    }
});

// Live game predictions endpoint for matches past halfway — ESPN first, API-Football merged fallback
app.get('/api/live-predictions', async (req, res) => {
    const { traceId } = req;
    logger.info('Live predictions request received', { traceId });

    try {
        const leaguesToCheck = [
            { sport: 'soccer', league: 'eng.1' },
            { sport: 'soccer', league: 'esp.1' },
            { sport: 'soccer', league: 'ita.1' },
            { sport: 'soccer', league: 'ger.1' },
            { sport: 'soccer', league: 'fra.1' },
            { sport: 'soccer', league: 'uefa.champions' },
            { sport: 'basketball', league: 'nba' },
            { sport: 'basketball', league: 'wnba' },
            { sport: 'tennis', league: 'atp' },
            { sport: 'tennis', league: 'wta' }
        ];

        const livePredictions = [];
        const seenIds = new Set();

        const processFixture = (fx, sport, leagueName) => {
            const id = String(fx.fixture?.id || fx.id || `${fx.homeTeam?.name}-${fx.awayTeam?.name}-${fx.fixture?.date}`);
            if (seenIds.has(id)) return;
            seenIds.add(id);

            const isNormalized = Boolean(fx.fixture && fx.homeTeam && fx.awayTeam);
            let status, clock, period, homeComp, awayComp;
            if (isNormalized) {
                status = fx.fixture.status;
                clock = fx.fixture.clock;
                period = fx.fixture.period || 0;
                homeComp = { team: fx.homeTeam, score: { value: fx.homeTeam.score }, homeAway: 'home' };
                awayComp = { team: fx.awayTeam, score: { value: fx.awayTeam.score }, homeAway: 'away' };
            } else {
                const comp = fx.competitions?.[0];
                status = comp?.status?.type?.state;
                clock = comp?.status?.displayClock;
                period = comp?.status?.period;
                const comps = comp?.competitors || [];
                homeComp = comps.find(c => c.homeAway === 'home') || comps[0];
                awayComp = comps.find(c => c.homeAway === 'away') || comps[1];
            }

            if (status !== 'in' && status !== 'live') return;

            let isPastHalfway = false;
            if (sport === 'soccer') {
                isPastHalfway = period >= 2 || (period === 1 && String(clock || '').includes('45'))
                    || (typeof clock === 'string' && /^([5-8]\d|90)/.test(clock));
            } else if (sport === 'basketball') {
                isPastHalfway = period >= 3 || (period === 2 && String(clock || '').includes('6'));
            } else {
                isPastHalfway = true;
            }

            if (!isPastHalfway || !homeComp || !awayComp) return;

            const homeTeamObj = homeComp.team || {};
            const awayTeamObj = awayComp.team || {};
            const homeScore = parseInt(homeComp.score?.value ?? (homeTeamObj.score ?? 0), 10);
            const awayScore = parseInt(awayComp.score?.value ?? (awayTeamObj.score ?? 0), 10);

            let prediction, confidence;
            if (homeScore > awayScore) {
                prediction = homeTeamObj.displayName || homeTeamObj.name || 'Home Team';
                confidence = 0.7 + Math.min(0.2, (homeScore - awayScore) * 0.05);
            } else if (awayScore > homeScore) {
                prediction = awayTeamObj.displayName || awayTeamObj.name || 'Away Team';
                confidence = 0.7 + Math.min(0.2, (awayScore - homeScore) * 0.05);
            } else {
                prediction = 'Draw/No Clear Favorite';
                confidence = 0.5;
            }

            livePredictions.push({
                id,
                name: fx.name || `${homeTeamObj.displayName || homeTeamObj.name || 'Home'} vs ${awayTeamObj.displayName || awayTeamObj.name || 'Away'}`,
                league: leagueName || fx.league?.name || leagueName,
                sport,
                time: clock || '',
                period: period || 0,
                homeTeam: {
                    name: homeTeamObj.displayName || homeTeamObj.name,
                    score: homeScore,
                    logo: homeTeamObj.logo || homeTeamObj.logos?.[0]?.href,
                },
                awayTeam: {
                    name: awayTeamObj.displayName || awayTeamObj.name,
                    score: awayScore,
                    logo: awayTeamObj.logo || awayTeamObj.logos?.[0]?.href,
                },
                prediction,
                source: isNormalized ? fx.source || 'merged' : 'espn',
                confidence: Math.round(confidence * 100) / 100,
            });
        };

        const leaguePromises = leaguesToCheck.map(async ({ sport, league }) => {
            try {
                const target = `${sport}/${league}/scoreboard`;
                const scoreboardData = await fetchFromBackendOrESPN(target);
                if (scoreboardData?.events) {
                    scoreboardData.events.forEach(e => processFixture(e, sport, league));
                }
            } catch (err) {
                logger.debug('ESPN live league fetch failed (may fall back via API-Football)', {
                    traceId, sport, league, error: err.message,
                });
            }
        });

        await Promise.all(leaguePromises);

        try {
            const mergedLive = await sportsData.getLiveFixtures({ traceId, leagueConfigs: leaguesToCheck });
            mergedLive.forEach(fx => processFixture(fx, fx.sport || 'soccer', fx.league?.name || fx.league?.id || ''));
        } catch (err) {
            logger.warn('SportsDataService live fixtures merge failed', { traceId, error: err.message });
        }

        res.json({ livePredictions, traceId, count: livePredictions.length });
    } catch (error) {
        logger.error('Error fetching live predictions', { traceId, error: error.message });
        res.status(500).json({ error: 'Failed to fetch live predictions', traceId });
    }
});

// Nightly Retraining Cron
if (IS_ENTRY_POINT) cron.schedule('0 2 * * *', () => {
  const traceId = uuidv4();
  logger.info('Starting nightly prediction retraining...', { traceId });
  
  const pythonProcess = spawn('python', [
    path.join(__dirname, 'prediction_engine', 'nightly_job.py')
  ]);

  pythonProcess.stdout.on('data', (data) => {
    logger.info('Retraining log', { traceId, message: data.toString() });
  });

  pythonProcess.stderr.on('data', (data) => {
    logger.error('Retraining error', { traceId, error: data.toString() });
  });
});

// WebSocket connection
io.on('connection', (socket) => {
  logger.info('New client connected', { socketId: socket.id });
  socket.on('disconnect', () => {
    logger.info('Client disconnected', { socketId: socket.id });
  });
});

// Start server
if (IS_ENTRY_POINT) server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Scheduled Job: Monthly token distribution
if (IS_ENTRY_POINT) cron.schedule('0 0 1 * *', async () => {
  const traceId = uuidv4();
  logger.info('Running monthly token distribution job...', { traceId });
  try {
    const db = admin.firestore();
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('tokens', '>=', 250).get();
    
    if (snapshot.empty) {
      logger.info('No eligible users found for monthly tokens.', { traceId });
      return;
    }

    logger.info(`Found ${snapshot.size} users eligible for monthly tokens.`, { traceId });

    const batchSize = 500;
    const batches = [];
    let batch = db.batch();
    let operationCounter = 0;

    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        tokens: admin.firestore.FieldValue.increment(15)
      });
      operationCounter++;
      if (operationCounter === batchSize) {
        batches.push(batch.commit());
        batch = db.batch();
        operationCounter = 0;
      }
    });

    if (operationCounter > 0) {
      batches.push(batch.commit());
    }

    await Promise.all(batches);
    logger.info('Monthly token distribution completed successfully.', { traceId });
  } catch (error) {
    logger.error('Error in monthly token distribution job', { traceId, error: error.message });
  }
});

module.exports = {
  app,
  server,
  io,
  sportsData,
  logger,
  analyzeMatchServer,
  rankFootballPredictions,
  FOOTBALL_UNDER_CORNERS_LINE,
  FOOTBALL_MARKET_PRIORITY,
};
