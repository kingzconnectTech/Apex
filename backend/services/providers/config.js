const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch (_) {}

const PROVIDERS = {
  ESPN: 'espn',
  PITCHAPI: 'pitchapi',
};

const ESPN_BASE = 'http://site.api.espn.com/apis/site/v2/sports';
const PITCHAPI_BASE = 'https://api.pitchapi.dev';

const PITCHAPI_KEY = process.env.PITCHAPI_KEY || '';
const PITCHAPI_ENABLED = process.env.PITCHAPI_ENABLED === undefined
  ? true
  : (process.env.PITCHAPI_ENABLED === 'true' || process.env.PITCHAPI_ENABLED === '1');

const TTL = {
  LEAGUES: 24 * 60 * 60 * 1000,
  TEAMS: 12 * 60 * 60 * 1000,
  FIXTURES_SCHEDULED: 30 * 60 * 1000,
  FIXTURES_LIVE: 30 * 1000,
  FIXTURES_FINISHED: 24 * 60 * 60 * 1000,
  STANDINGS: 60 * 60 * 1000,
  TEAM_STATS: 60 * 60 * 1000,
  H2H: 12 * 60 * 60 * 1000,
  DEFAULT: 5 * 60 * 1000,
};

module.exports = {
  PROVIDERS,
  ESPN_BASE,
  PITCHAPI_BASE,
  PITCHAPI_KEY,
  PITCHAPI_ENABLED,
  TTL,
};
