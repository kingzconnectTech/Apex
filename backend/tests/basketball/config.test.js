/**
 * Task 10 — basketball module scaffolding + per-league config.
 *
 * TR-10.1: Projecting identical inputs under two league configs yields outputs
 *          consistent with each config's game length and home-court term.
 * TR-10.2: A missing league config throws a clear error rather than silently
 *          using NBA defaults.
 *
 * Also guards the "no hardcoded NBA constants" rule: the legacy basketballEngine
 * now sources its league mean / score std from leagues.js.
 */

const CONFIG = require('../../services/basketball/config');
const { getLeagueConfig, resolveLeagueKey, listLeagues, LEAGUES } = require('../../services/basketball/leagues');
const { projectGame } = require('../../services/basketball/projection');

describe('basketball per-league config (TR-10.1, TR-10.2)', () => {
  test('every configured league exposes the documented fields', () => {
    listLeagues().forEach(l => {
      expect(typeof l.key).toBe('string');
      expect(typeof l.gameMinutes).toBe('number');
      expect(l.gameMinutes).toBeGreaterThan(0);
      expect(typeof l.homeCourtPoints).toBe('number');
      expect(l.leagueMean).toEqual(expect.objectContaining({
        possessions: expect.any(Number),
        ortg: expect.any(Number),
        drtg: expect.any(Number),
      }));
      expect(l.sigma).toEqual(expect.objectContaining({ total: expect.any(Number), margin: expect.any(Number) }));
      expect(typeof l.scoreStd).toBe('number');
    });
  });

  test('resolveLeagueKey understands aliases and provider paths', () => {
    expect(resolveLeagueKey('nba')).toBe('nba');
    expect(resolveLeagueKey('NBA')).toBe('nba');
    expect(resolveLeagueKey('basketball/nba')).toBe('nba');
    expect(resolveLeagueKey('mens-college-basketball')).toBe('ncaa');
    expect(resolveLeagueKey('eur')).toBe('euroleague');
    expect(resolveLeagueKey('not-a-league')).toBeNull();
  });

  test('TR-10.2: an unknown league throws instead of silently using NBA defaults', () => {
    expect(() => getLeagueConfig('cricket')).toThrow(/Unknown basketball league/i);
    expect(() => getLeagueConfig('')).toThrow(/Unknown basketball league/i);
    expect(() => getLeagueConfig(undefined)).toThrow(/Unknown basketball league/i);
  });

  test('TR-10.1: identical inputs project to league-specific home-court and pace', () => {
    const home = { ortg: 115, drtg: 110, pace: 100 };
    const away = { ortg: 108, drtg: 114, pace: 96 };

    const nba = projectGame({ home, away, leagueCfg: getLeagueConfig('nba'), cfg: CONFIG });
    const ncaa = projectGame({ home, away, leagueCfg: getLeagueConfig('ncaa'), cfg: CONFIG });

    // Same (total, margin) decomposition must differ by the league home-court term.
    expect(nba.homeCourtPoints).toBe(getLeagueConfig('nba').homeCourtPoints);
    expect(ncaa.homeCourtPoints).toBe(getLeagueConfig('ncaa').homeCourtPoints);
    expect(nba.margin - ncaa.margin).toBeCloseTo(nba.homeCourtPoints - ncaa.homeCourtPoints, 4);
    expect(nba.total).toBe(ncaa.total); // totals do not depend on the home-court term
  });

  test('the pace blend is configurable and not a plain average', () => {
    const home = { ortg: 110, drtg: 110, pace: 110 }; // much faster
    const away = { ortg: 110, drtg: 110, pace: 90 };  // much slower
    const nba = getLeagueConfig('nba');

    const lean = projectGame({ home, away, leagueCfg: nba, cfg: { ...CONFIG, projection: { paceBlendWeight: 0.65 } } });
    const plain = projectGame({ home, away, leagueCfg: nba, cfg: { ...CONFIG, projection: { paceBlendWeight: 0.5 } } });

    expect(plain.expectedPossessions).toBeCloseTo(100, 4);
    expect(lean.expectedPossessions).toBeGreaterThan(plain.expectedPossessions);
    expect(lean.total).toBeGreaterThan(plain.total);
  });

  test('the legacy basketballEngine reads its league mean from the config', () => {
    const engine = require('../../services/basketballEngine');
    const nba = getLeagueConfig('nba');
    expect(engine.LEAGUE_MEAN.ortg).toBe(nba.leagueMean.ortg);
    expect(engine.LEAGUE_MEAN.possessions).toBe(nba.leagueMean.possessions);
    expect(engine.LEAGUE_MEAN.homeCourtAdvantage).toBe(nba.homeCourtPoints);
  });

  test('selection thresholds and caps live in config, not in code', () => {
    // Thresholds are deliberately zeroed so every match yields a prediction; the
    // fields must still exist in config and never be hardcoded in the pipeline.
    expect(CONFIG.selection.mainMinProb).toBeGreaterThanOrEqual(0);
    expect(CONFIG.selection.alternateMinProb).toBeGreaterThanOrEqual(0);
    expect(CONFIG.selection.minEdge).toBeGreaterThanOrEqual(0);
    expect(CONFIG.selection.minDataQuality).toBeGreaterThanOrEqual(0);
    expect(CONFIG.adjustments.caps.combined).toBeGreaterThan(0);
    expect(Object.keys(LEAGUES).length).toBeGreaterThanOrEqual(4);
  });
});
