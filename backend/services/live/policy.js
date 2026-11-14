/**
 * live/policy.js
 *
 * Phase 6 — the honesty switches, in one place.
 *
 * Two independent questions, deliberately kept apart:
 *   1. Is the FEATURE on? (`live.enabled`, `live.sports[sport]`) — a product
 *      switch. Off means the endpoint 404s/503s and the UI hides the entry.
 *   2. May a live PROBABILITY ship? (`live.picks`) — the Phase 5 ship gate.
 *      A sport can be fully enabled and still ship nothing, because its
 *      backtest has not cleared the bar. That is the current state.
 *
 * Nothing here ever returns a number. It only returns permission, plus the
 * reason when permission is refused, so the API and the UI can say why rather
 * than quietly showing an unvalidated figure.
 */

const CONFIG = require('./config');
const forwardTest = require('./forwardTest');

/** Feature-level state, for the capabilities endpoint and the UI entry point. */
function featureState() {
  const sports = {};
  for (const sport of CONFIG.live.supportedSports) {
    sports[sport] = Boolean(CONFIG.live.enabled && CONFIG.live.sports[sport]);
  }
  return {
    enabled: Boolean(CONFIG.live.enabled),
    sports,
    supported_sports: [...CONFIG.live.supportedSports],
    // Hand-typed games are a separate switch; the UI hides the manual form when
    // this is off without hiding the whole live surface.
    manual_entry: manualEntryEnabled(),
    // Sports whose backtest has passed and may therefore show a probability.
    shipping: shippingSports(),
    // Phase 9 — sports observed in SHADOW: the live probability is computed and
    // logged as evidence, but withheld from everyone. Public by design (it names
    // no identity), so the UI can say "collecting live evidence" honestly.
    shadow: shadowSports(),
    // Phase 9 — the testers-only bridge between "gate passed" and "shipped to
    // all". Public by design (it carries no identity), so the UI can say
    // "preview" without learning WHO the testers are.
    rollout: {
      testers_only: CONFIG.live.rollout ? CONFIG.live.rollout.testersOnly !== false : false,
      sports: rolloutSports(),
    },
  };
}

/** Sports/leagues/markets cleared to preview a pick to recognised testers. */
function rolloutSports() {
  const r = CONFIG.live.rollout;
  const out = {};
  if (!r || !r.sports) return out;
  Object.entries(r.sports).forEach(([sport, cfg]) => {
    out[sport] = { leagues: [...((cfg && cfg.leagues) || [])], market: (cfg && cfg.market) || null };
  });
  return out;
}

/** The rollout entry for one sport, or null when the sport has no rollout. */
function rolloutFor(sport) {
  const r = CONFIG.live.rollout;
  if (!r || !r.sports || !sport) return null;
  return r.sports[sport] || null;
}

/**
 * The identities recognised as testers: the configured list merged with the
 * comma-separated environment variable (CONFIG.live.rollout.testerIdsEnv).
 * Never returned to a client — only used to decide a preview.
 */
function testerIds() {
  const r = CONFIG.live.rollout || {};
  const fromEnv = r.testerIdsEnv && process.env[r.testerIdsEnv]
    ? String(process.env[r.testerIdsEnv]).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  return [...new Set([...(r.testerIds || []), ...fromEnv])];
}

/**
 * Is this client identity a recognised tester? A ROLLOUT selector, not an
 * authorization boundary: it decides who previews a pick, never who may call
 * the API, and it can be spoofed by asserting the header — which is exactly why
 * the pick it unlocks is a limited preview, not privileged data.
 */
function isRecognisedTester(identity) {
  if (!identity) return false;
  return testerIds().includes(String(identity));
}

/** Is the feature on for this sport (or at all, when sport is null)? */
function isFeatureEnabled(sport = null) {
  if (!CONFIG.live.enabled) return false;
  if (!sport) return true;
  return CONFIG.live.sports[sport] === true;
}

/** May a user hand-type a game? Independent of the per-sport switches. */
function manualEntryEnabled() {
  return Boolean(CONFIG.live.enabled && CONFIG.live.manualEntry);
}

/** Sports with at least one league that has cleared the ship gate. */
function shippingSports() {
  const out = [];
  for (const sport of CONFIG.live.supportedSports) {
    const leagues = CONFIG.live.picks[sport];
    if (Array.isArray(leagues) && leagues.length > 0) out.push(sport);
  }
  return out;
}

/**
 * Sports observed in SHADOW: the live probability is computed and logged as
 * evidence, but shown to nobody. This is the deliberate hold between a kept
 * calibrator and a shipped pick, used while a sport's evidence is still being
 * gathered on live games. A sport that has started shipping is not shadow —
 * removing it here is how the hold is released.
 */
function shadowSports() {
  const shadow = CONFIG.live.shadow;
  if (!shadow || shadow.enabled === false) return [];
  const listed = Array.isArray(shadow.sports) ? shadow.sports : [];
  const shipping = shippingSports();
  return listed.filter(sport => !shipping.includes(sport));
}

/**
 * May a live probability (or any model projection) be shown for this game?
 *
 * Four gates, in order:
 *   1. Feature switches — is the surface on for this sport at all?
 *   2. Hand-typed games — always refused (nothing about them is verified).
 *   3. Forward-test auto-disable — a drifted pick is withdrawn for EVERYONE,
 *      tester or not, until the realised numbers match the backtest again.
 *   4. The ship gate — the public allowlist (`live.picks`) first, then the
 *      testers-only rollout (`live.rollout`). A recognised tester previews a
 *      league that has cleared the gate but is not public yet.
 *
 * @param {Object} args
 * @param {string} args.sport
 * @param {string|null} [args.league] ESPN league id, e.g. 'nba' or 'eng.1'
 * @param {boolean} [args.manual] true for a hand-typed game
 * @param {boolean} [args.tester] true when the caller is a recognised tester
 * @returns {{allowed:boolean, reason:(string|null), sport:string, league:(string|null), audience:('public'|'testers'|null)}}
 *   `allowed:false` always carries a human-readable `reason`.
 */
function mayShipPick({ sport = null, league = null, manual = false, tester = false } = {}) {
  const base = { sport, league: league || null };

  if (!CONFIG.live.enabled) {
    return { ...base, allowed: false, audience: null, reason: 'live analysis is switched off globally' };
  }
  if (!sport) {
    return { ...base, allowed: false, audience: null, reason: 'the sport of this game is unknown' };
  }
  if (CONFIG.live.sports[sport] !== true) {
    return { ...base, allowed: false, audience: null, reason: `live analysis is switched off for ${sport}` };
  }
  // Hand-typed games never ship: nothing about them has been verified against a
  // provider, and they are excluded from the statistics that would justify a
  // probability in the first place.
  if (manual) {
    return {
      ...base,
      allowed: false,
      audience: null,
      reason: 'this game was entered by hand, so no validated live probability is shown',
    };
  }

  // Forward-test auto-disable outranks every audience: when the live numbers
  // have drifted past tolerance, the pick is retired even for a tester.
  if (CONFIG.live.forwardTest && CONFIG.live.forwardTest.enabled !== false) {
    const verdict = forwardTest.evaluate(sport);
    if (verdict.status === 'disabled') {
      return {
        ...base,
        allowed: false,
        audience: null,
        reason: `the ${sport} live pick is auto-disabled: ${verdict.reason}`,
      };
    }
  }

  const publicLeagues = CONFIG.live.picks[sport];
  if (!Array.isArray(publicLeagues)) {
    return {
      ...base,
      allowed: false,
      audience: null,
      reason: `no ship-gate allowlist is configured for ${sport}`,
    };
  }

  // SHADOW hold (Phase 9). The sport's live probability is computed and logged
  // as evidence but is withheld from EVERY client while it is still being
  // validated on live games. Say that plainly (rather than quoting the internal
  // Phase 5 reference) so the context-only screen tells the reader why the
  // numbers are absent. A shadow sport is never in the public allowlist or the
  // rollout, so this sits ahead of both.
  if (shadowSports().includes(sport)) {
    return {
      ...base,
      allowed: false,
      audience: null,
      reason: `live probabilities for ${sport} are still being validated on live games and are not shown yet`,
    };
  }

  // 1. Public allowlist — the gate has passed and the pick ships to everyone.
  if (league && publicLeagues.includes(league)) {
    return { ...base, allowed: true, audience: 'public', reason: null };
  }

  // 2. Testers-only rollout — the gate has passed but the public pick is not
  //    switched on yet (Phase 9).
  const rollout = rolloutFor(sport);
  const inRollout = Boolean(rollout && league && Array.isArray(rollout.leagues) && rollout.leagues.includes(league));
  if (inRollout) {
    if (CONFIG.live.rollout.testersOnly === false) {
      return { ...base, allowed: true, audience: 'public', reason: null };
    }
    if (tester) return { ...base, allowed: true, audience: 'testers', reason: null };
    return {
      ...base,
      allowed: false,
      audience: null,
      reason: `${sport}/${league} has cleared the ship gate and is in a preview rollout; the public pick opens once forward testing clears.`,
    };
  }

  // 3. Refusals, each carrying the reason the UI shows.
  if (!publicLeagues.length) {
    return {
      ...base,
      allowed: false,
      audience: null,
      reason: `the ${sport} backtest has not passed the Phase 5 ship gate, so no live probability is shown (see backend/docs/PHASE_5_LIVE_VALIDATION.md)`,
    };
  }
  if (!league) {
    return {
      ...base,
      allowed: false,
      audience: null,
      reason: 'the competition of this game could not be established, so the ship gate cannot be checked',
    };
  }
  return {
    ...base,
    allowed: false,
    audience: null,
    reason: `${sport}/${league} has not passed the Phase 5 ship gate, so no live probability is shown`,
  };
}

module.exports = {
  featureState,
  isFeatureEnabled,
  manualEntryEnabled,
  shippingSports,
  shadowSports,
  mayShipPick,
  rolloutSports,
  rolloutFor,
  testerIds,
  isRecognisedTester,
};
