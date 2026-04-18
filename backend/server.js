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

// Initialize Express app
const app = express();
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

// Enhanced Cache
// key: full ESPN URL
// value: { data: any, expiresAt: number, lastModified: string, hash: string }
const cache = new Map();
const DEFAULT_TTL_MS = 60 * 1000; // 1 minute (reduced from 1 hour)
const STALE_TTL_MS = 500; // Trigger refresh if data is older than 500ms

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

  try {
    if (!isValidRelativeTarget(target)) {
      return res.status(400).json({ error: 'Invalid target', traceId });
    }
    const upstreamUrl = `${ESPN_BASE}/${target}`;

    const cached = getCache(upstreamUrl);
    
    if (cached && !force) {
      // If data is older than 500ms, trigger background refresh
      if (Date.now() - cached.lastUpdated > STALE_TTL_MS) {
        refreshAndNotify(upstreamUrl, traceId);
      }
      return res.json(cached.data);
    }

    // Fetch and cache
    const data = await fetchWithRetry(upstreamUrl, traceId);
    setCache(upstreamUrl, data);
    return res.json(data);
  } catch (e) {
    logger.error('Proxy error', { traceId, target, error: e.message });
    return res.status(502).json({ error: 'Upstream fetch failed', traceId });
  }
});

// Periodic cache cleanup
cron.schedule('*/5 * * * *', () => {
  const nowTs = Date.now();
  let removed = 0;
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt < nowTs) {
      cache.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logger.info(`Cache cleanup: removed ${removed} expired entries`);
  }
});

// Basic route
app.get('/', (req, res) => {
  res.send('Apex API is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), traceId: req.traceId });
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

// Nightly Retraining Cron
cron.schedule('0 2 * * *', () => {
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
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Scheduled Job: Monthly token distribution
cron.schedule('0 0 1 * *', async () => {
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
