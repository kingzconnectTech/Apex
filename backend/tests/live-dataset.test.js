/**
 * Phase 8 — replay dataset acquisition tests.
 *
 * Two things are pinned here and nothing else:
 *   - The ESPN cache/throttle layer (services/live/espnCache), exercised with an
 *     injected fetch so no network is touched.
 *   - The sweep planner in scripts/run-live-backtest.js: which (sport, league,
 *     season, day) reads a run schedules, and that overlapping seasons never
 *     fetch the same board twice.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCachedFetch, cachePath } = require('../services/live/espnCache');
const { sharedCache } = require('../services/providers/cache');
const {
  expandDates,
  buildSweepTasks,
  parseList,
  makeCacheFlusher,
} = require('../scripts/run-live-backtest');

/* ------------------------------------------------------------------ helpers */

let tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-live-cache-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  tmpDirs.forEach(dir => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  tmpDirs = [];
});

/* --------------------------------------------------------------------- cache */

describe('espnCache', () => {
  test('caches a body on disk and serves the second read from the cache', async () => {
    const dir = tmpDir();
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, async json() { return { url }; } };
    };
    const cachedFetch = createCachedFetch({ cacheDir: dir, minIntervalMs: 0, fetchFn });

    const first = await (await cachedFetch('http://x/1')).json();
    const second = await (await cachedFetch('http://x/1')).json();

    expect(first).toEqual({ url: 'http://x/1' });
    expect(second).toEqual(first);
    expect(calls.length).toBe(1);
    expect(cachedFetch.stats).toMatchObject({ hits: 1, misses: 1, fetches: 1 });
  });

  test('returns a 4xx response as-is and never caches it', async () => {
    const dir = tmpDir();
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return { ok: false, status: 404, async json() { return null; } };
    };
    const cachedFetch = createCachedFetch({ cacheDir: dir, minIntervalMs: 0, retries: 0, fetchFn });

    const res = await cachedFetch('http://x/missing');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);

    await cachedFetch('http://x/missing');
    expect(calls).toBe(2); // a 404 today is not proof of a 404 tomorrow
  });

  test('retries a 5xx with backoff and succeeds when the upstream recovers', async () => {
    const dir = tmpDir();
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      if (attempts < 3) return { ok: false, status: 503, async json() { return null; } };
      return { ok: true, status: 200, async json() { return { recovered: true }; } };
    };
    const cachedFetch = createCachedFetch({ cacheDir: dir, minIntervalMs: 0, retries: 3, backoffMs: 1, fetchFn });

    const body = await (await cachedFetch('http://x/flaky')).json();
    expect(body).toEqual({ recovered: true });
    expect(attempts).toBe(3);
  });

  test('throws after exhausting retries on a persistent failure', async () => {
    const dir = tmpDir();
    const fetchFn = async () => ({ ok: false, status: 500, async json() { return null; } });
    const cachedFetch = createCachedFetch({ cacheDir: dir, minIntervalMs: 0, retries: 1, backoffMs: 1, fetchFn });

    await expect(cachedFetch('http://x/down')).rejects.toThrow(/upstream 500/);
  });

  test('drops a corrupt cache file and refetches rather than serving garbage', async () => {
    const dir = tmpDir();
    const fetchFn = async (url) => ({ ok: true, status: 200, async json() { return { url }; } });
    const cachedFetch = createCachedFetch({ cacheDir: dir, minIntervalMs: 0, fetchFn });

    await cachedFetch('http://x/corrupt');
    fs.writeFileSync(cachePath(dir, 'http://x/corrupt'), '{ truncated');

    const again = await (await cachedFetch('http://x/corrupt')).json();
    expect(again).toEqual({ url: 'http://x/corrupt' });
    expect(cachedFetch.stats.fetches).toBe(2);
  });

  test('enforces the minimum gap between outbound request starts', async () => {
    const dir = tmpDir();
    const minIntervalMs = 50;
    const starts = [];
    const fetchFn = async () => {
      starts.push(Date.now());
      return { ok: true, status: 200, async json() { return {}; } };
    };
    const cachedFetch = createCachedFetch({ cacheDir: dir, minIntervalMs, fetchFn });

    await Promise.all([
      cachedFetch('http://t/1'), cachedFetch('http://t/2'), cachedFetch('http://t/3'),
    ]);

    expect(starts.length).toBe(3);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(minIntervalMs - 10);
    }
  });

  test('requires a cacheDir', () => {
    expect(() => createCachedFetch({})).toThrow(/requires a cacheDir/);
  });
});

/* ------------------------------------------------------------------- planner */

describe('expandDates', () => {
  test('accepts a single day and an inclusive range', () => {
    expect(expandDates('20260101')).toEqual(['20260101']);
    expect(expandDates('20260101-20260103')).toEqual(['20260101', '20260102', '20260103']);
  });

  test('honours the maxDays safety cap for a long season range', () => {
    expect(expandDates('20251021-20260412', 100).length).toBe(100);
    // The default cap still expands an ordinary range in full.
    expect(expandDates('20251021-20251120').length).toBe(31);
  });

  test('returns nothing for junk or a reversed range', () => {
    expect(expandDates('not-a-date')).toEqual([]);
    expect(expandDates('20260103-20260101')).toEqual([]);
  });
});

describe('buildSweepTasks', () => {
  test('schedules one scoreboard read per league, season and day', () => {
    const tasks = buildSweepTasks({
      sports: ['basketball'],
      sweep: { basketball: ['nba'] },
      seasons: { basketball: [{ label: '2025-26', from: '20251021', to: '20251023' }] },
    });
    expect(tasks.map(t => t.day)).toEqual(['20251021', '20251022', '20251023']);
    expect(tasks.every(t => t.sport === 'basketball' && t.league === 'nba' && t.season === '2025-26')).toBe(true);
  });

  test('de-duplicates overlapping seasons so a board is never fetched twice', () => {
    const tasks = buildSweepTasks({
      sports: ['basketball'],
      sweep: { basketball: ['nba'] },
      seasons: {
        basketball: [
          { label: 'A', from: '20251021', to: '20251023' },
          { label: 'B', from: '20251022', to: '20251024' },
        ],
      },
    });
    expect(tasks.length).toBe(4); // 21,22,23,24 — not 6
    expect(new Set(tasks.map(t => t.day)).size).toBe(4);
  });

  test('an explicit --dates override replaces the seasons', () => {
    const tasks = buildSweepTasks({
      sports: ['soccer'],
      sweep: { soccer: ['eng.1'] },
      seasons: { soccer: [{ label: '2025-26', from: '20250801', to: '20260531' }] },
      dates: '20260301',
    });
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({ league: 'eng.1', day: '20260301', season: 'custom' });
  });

  test('a --dates range override expands to one day each, not a doubled range', () => {
    const tasks = buildSweepTasks({
      sports: ['basketball'],
      sweep: { basketball: ['nba'] },
      dates: '20260401-20260403',
    });
    expect(tasks.map(t => t.day)).toEqual(['20260401', '20260402', '20260403']);
    expect(tasks.every(t => t.season === 'custom')).toBe(true);
  });

  test('defaults to the configured seasons for every swept league', () => {
    const tasks = buildSweepTasks({ sports: ['basketball'], sweep: { basketball: ['nba'] } });
    // Two basketball seasons (~174 days each) for one league.
    expect(tasks.length).toBeGreaterThan(300);
    expect(new Set(tasks.map(t => t.season))).toEqual(new Set(['2025-26', '2024-25']));
  });

  test('scopes a season range to the leagues it names', () => {
    const seasons = {
      basketball: [
        { label: 'NBA', from: '20251021', to: '20251022' },
        { label: 'WNBA', from: '20250501', to: '20250502', leagues: ['wnba'] },
      ],
    };
    const nba = buildSweepTasks({ sports: ['basketball'], sweep: { basketball: ['nba'] }, seasons });
    expect(nba.map(t => t.day)).toEqual(['20251021', '20251022']);
    expect(nba.every(t => t.season === 'NBA')).toBe(true);

    // A league-scoped range applies only to the league(s) it names; the
    // unscoped NBA range still applies to the WNBA as well.
    const wnba = buildSweepTasks({ sports: ['basketball'], sweep: { basketball: ['wnba'] }, seasons });
    expect(wnba.filter(t => t.season === 'WNBA').map(t => t.day)).toEqual(['20250501', '20250502']);
    expect(new Set(wnba.map(t => t.day))).toEqual(new Set(['20251021', '20251022', '20250501', '20250502']));
  });

  test('an unknown sport/league yields no tasks rather than a bogus sweep', () => {
    expect(buildSweepTasks({ sports: ['curling'], sweep: {} })).toEqual([]);
  });
});

describe('parseList', () => {
  test('splits, trims and drops empty tokens', () => {
    expect(parseList('nba, wnba ,, mens-college-basketball')).toEqual(['nba', 'wnba', 'mens-college-basketball']);
    expect(parseList('')).toEqual([]);
  });
});

describe('makeCacheFlusher', () => {
  test('flushes the provider cache every N reads and leaves gaps alone', () => {
    sharedCache.clear();
    sharedCache.set('k', null, { big: true }, 60000);
    const noteRead = makeCacheFlusher(3);

    noteRead(); noteRead();
    expect(sharedCache.size()).toBe(1); // not yet
    noteRead();
    expect(sharedCache.size()).toBe(0); // flushed on the 3rd
  });

  test('is inert when the interval is disabled', () => {
    sharedCache.clear();
    sharedCache.set('k', null, { big: true }, 60000);
    const noteRead = makeCacheFlusher(0);
    for (let i = 0; i < 10; i++) noteRead();
    expect(sharedCache.size()).toBe(1);
    sharedCache.clear();
  });
});
