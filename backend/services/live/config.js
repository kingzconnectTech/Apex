/**
 * live/config.js
 *
 * Configuration for Live Game Analysis (Phase 1-6).
 *
 * Every threshold, tier, TTL and league list lives here so shared code paths
 * never hardcode a constant. Parser *rules* (per-domain + generic regexes) live
 * in ./linkPatterns.js and the alias *data* lives in ./teamAliases.js; this file
 * holds the numbers those rules are scored and gated with.
 *
 * Conventions follow services/basketball/config.js: plain object, camelCase keys,
 * exported directly.
 */

const CONFIG = {
  /**
   * Master switches. Phase 6 exposes these to the API/UI; they are the single
   * source of truth for "is this feature on for this sport".
   */
  live: {
    enabled: true,
    sports: {
      soccer: true,
      basketball: true,
    },
    /**
     * Phase 7 — manual entry has its OWN switch. Turning the live surface on
     * does not turn on hand-typed games; they can be refused independently
     * without switching the whole feature off.
     */
    manualEntry: true,
    // Sports we are able to build a validated live model for (Phase 0 decision).
    // Anything else resolves to manual entry only.
    supportedSports: ['soccer', 'basketball'],

    /**
     * SHIP GATE (Phase 5 -> Phase 6 hand-off).
     *
     * The only sports/leagues whose backtest PASSED, i.e. the only places a live
     * PROBABILITY (or any model projection) may be shown.
     *
     * ⚠️ DELIBERATELY OPENED — OWNER OVERRIDE (2026-11-18). Normally this list
     * is built league-by-league for competitions that have passed the Phase 5
     * gate, and the rule below forbids editing it to make a number appear. At
     * the owner's explicit request it is opened to EVERY league we can identify
     * so picks are visible now. The gate criteria are NOT met (confirmation
     * dataset 0/500 for both sports) — see docs/PHASE_5_LIVE_VALIDATION.md.
     *
     * To RESTORE the honest hold: empty both arrays. `shadow.sports` below
     * still lists both, and `policy.shadowSports()` excludes any sport that is
     * shipping, so emptying a sport's `picks` here puts it straight back under
     * the hold — no second edit needed. Values are ESPN league ids and must
     * mirror the values in `matchFeed.leagueIds` (the name -> id bridge for
     * score-site games); a league missing from that map can never resolve from a
     * score site.
     */
    picks: {
      soccer: [
        'eng.1', 'eng.2', 'eng.3', 'eng.4', 'esp.1', 'esp.2', 'ita.1', 'ita.2',
        'ger.1', 'ger.2', 'ned.1', 'ned.2', 'por.1', 'por.2', 'tur.1', 'rus.1',
        'ukr.1', 'bel.1', 'sct.1', 'sct.2', 'aut.1', 'grc.1', 'dnk.1', 'swe.1',
        'nor.1', 'cze.1', 'mex.1', 'bra.1', 'usa.1', 'jpn.1', 'kor.1', 'chn.1',
        'saudi.1', 'conmebol.libertadores', 'uefa.champions', 'uefa.europa',
        'uefa.europaconference',
      ],
      basketball: [
        'nba', 'wnba', 'mens-college-basketball', 'womens-college-basketball',
        'euroleague', 'eurocup', 'acb',
      ],
    },

    /**
     * OWNER OVERRIDE (2026-11-18) — LIVE-ALWAYS.
     *
     * When true, `policy.mayShipPick` ships a live probability or projection for
     * ANY live game in a supported sport — including a competition that does not
     * map to an ESPN league id (the score sites name leagues we have no id for).
     * This is what makes live match analysis ALWAYS return a stats-based
     * prediction instead of degrading to score-and-clock-only.
     *
     * It deliberately does NOT override: the global/per-sport feature switches,
     * the refusal of hand-typed games, or the Phase 9 SHADOW hold below — a sport
     * whose `picks` entry is empty and that is listed in `shadow.sports` is still
     * withheld, so the honest hold (and the tests that exercise it) survive.
     *
     * Set false to fall back to the league-by-league `picks` allowlist above.
     */
    shipAllLive: true,

    /**
     * Phase 11 — LIVE PICKS (the recommendation shown above the probabilities).
     *
     * The live model outputs probabilities and a projection; these settings turn
     * them into the two picks the Live Analysis screen shows: the match-result
     * pick (1X2 in soccer, moneyline in basketball) and the Over/Under pick.
     *
     * The live model has NO bookmaker line to compare against, so the O/U pick is
     * made against a FIXED standard line per sport/league. Because the line is a
     * constant (never the live projection), the pick's confidence moves honestly
     * as the live game state moves the projection away from it.
     */
    pickMarkets: {
      enabled: true,
      overUnder: {
        // Soccer: the standard main line. A half point (X.5) so a total can
        // never push.
        soccer: { line: 2.5 },
        // Basketball: `line` pins every league when set. When null the line is
        // the league's own mean total (basketball/leagues.js) rounded to the
        // nearest half point, so it stays a fixed per-league constant;
        // `defaultLine` covers a league basketball/leagues.js does not know.
        basketball: {
          line: null,
          defaultLine: 219.5,
          // Multi-line totals evaluation: every supported line is priced
          // independently (Over AND Under) off the model's expected total and
          // sigma, with settled-market statuses. A pick is only emitted for
          // the strongest available side, and only when its probability
          // clears `minPickProbability` — the same 75% bar basketball
          // predictions already use elsewhere. Below it: no pick, no guess.
          evaluationLines: [209.5, 214.5, 219.5, 224.5, 229.5, 234.5],
          // The pick is the line NEAREST the expected total (the main total),
          // side = argmax(Over, Under). No minimum-probability gate: a totals
          // pick at the main line is legitimately ~50/50, and suppressing it
          // would hide the model's honest read. Settled lines are still
          // excluded — a decided market is never a fresh pick.
          minPickProbability: 0.0,
        },
      },
    },

    /**
     * Phase 9 — SHIP ROLLOUT (testers-only bridge).
     *
     * `live.picks` above is the PUBLIC allowlist: populating it ships a pick to
     * every user immediately. Between "the gate passed" and "forward testing has
     * confirmed it on real games" we want a limited audience instead, so this is
     * a SEPARATE switch. `rollout.sports` names the sports/leagues/markets that
     * have cleared the gate and may preview a pick to recognised testers only.
     *
     * `testersOnly:true` → only a recognised tester sees the pick. Flip it to
     * false (and mirror the league into `live.picks`) once forward testing has
     * cleared forwardTest.minGames games.
     *
     * The identity is the same client-asserted signal the rate limiter already
     * uses (see ./rateLimit.js): this is a ROLLOUT selector, NOT an
     * authorization boundary — it decides who previews a pick, never who may
     * call the API.
     */
    rollout: {
      testersOnly: true,
      // Header carrying the client identity; LIVE_TESTER_IDS is merged in.
      identityHeader: 'x-user-id',
      testerIds: [],
      testerIdsEnv: 'LIVE_TESTER_IDS',
      sports: {
        // HELD (Phase 9): basketball is observed in `shadow` below, NOT previewed
        // to testers. The leakage-free production-column ship gate has not
        // cleared the Brier-gain 95% CI clause yet (see `shadow`), so no pick is
        // offered to any audience. Populate this — and mirror the league into
        // `picks` once forward testing clears — only when that clause passes.
      },
    },

    /**
     * Phase 9 — SHADOW observation (the current "hold" state).
     *
     * A sport listed here has its live WINNER probability computed and appended
     * to the forward-test log as EVIDENCE, but WITHHELD from every client, public
     * and tester alike. It is the deliberate step between "the calibration gate
     * kept the calibrator" and "the pick ships": nothing is shown until the live
     * numbers confirm the backtest benchmark over forwardTest.minGames games.
     *
     * Basketball sits here because the Phase 9 fit found the leakage-free
     * production column fails exactly one ship-gate clause — its Brier-gain 95%
     * CI lower bound rounds to 0.0000 and the gate requires > 0 — while every
     * other clause passes. See docs/PHASE_5_LIVE_VALIDATION.md.
     *
     * Shadow rows never count toward the served-pick auto-disable (that watches
     * the population users actually saw); they are reported separately so the
     * decision to roll out is made on live evidence, not a backtest rerun.
     */
    shadow: {
      enabled: true,
      // Phase 10 — soccer joins basketball in shadow. Basketball is a CANDIDATE
      // awaiting 500 fresh games (Phase 10 item 1); soccer is observed only so
      // its frozen candidate columns (item 5) can be scored on fresh data. No
      // soccer (or basketball) pick ships from this.
      sports: ['basketball', 'soccer'],
      /**
       * Phase 9 — the SHADOW SCHEDULER. The forward log is otherwise written
       * only when a user resolves or polls a game, so a held sport would gather
       * evidence at whatever rate it happens to be requested — and none at all
       * if nobody asks. This job sweeps the configured leagues on a fixed
       * cadence and records a shadow row for every live game, independent of any
       * user request.
       */
      scheduler: {
        enabled: true,
        // Every 5 minutes. A period change (i.e. each quarter) is itself a new
        // row because the log dedupes on (probability, clock, period), so the
        // cadence yields a checkpoint every five minutes plus one per quarter.
        cron: '*/5 * * * *',
      },
      /**
       * Round J (item 5) — the DAILY RECONCILE.
       *
       * The counters in `live_shadow/meta` are a CACHE; the rows are the truth.
       * Once a day this recounts the rows (`count()` aggregation on Firestore)
       * and compares the result to the counters, recording any counter-vs-recount
       * drift in the durable health document. /api/live/stats surfaces that drift
       * and raises a `counter_drift` alert on any non-zero delta, so a counter
       * that has silently drifted is caught by the pipeline rather than trusted.
       */
      reconcile: {
        enabled: true,
        // 03:00 UTC — an hour after the nightly retrain (02:00) so the two jobs
        // never contend. Daily is deliberate: the recount is O(configured
        // leagues) of aggregation reads, cheap once a day but not per sweep.
        cron: '0 3 * * *',
      },
      /**
       * Phase 10 — FROZEN shadow-candidate columns (items 2 and 5).
       *
       * The candidate models were fitted once (scripts/run-live-phase10-report.js)
       * and written to `file` with a version id and their parameters. Their
       * probability is computed at the SAME checkpoint as the shadow row and
       * logged on it, so the fresh-data evaluation (>= 500 settled games) can be
       * made once against a fixed target. They are NEVER refit here — the
       * artifact is read-only. When the artifact is absent, no candidate column
       * is logged (never a fabricated number).
       */
      candidates: {
        enabled: true,
        // Relative to the backend directory; written by the Phase 10 report.
        file: 'data/live-shadow-candidates.json',
      },
    },

    /**
     * Phase 9 — persisted LIVE calibrator.
     *
     * The ship gate scores the walk-forward CALIBRATED column (`pShipped`);
     * production must serve exactly that column, not the raw `pRaw`. The kept
     * calibrator is fitted offline (scripts/fit-live-calibrator.js) and written
     * here. When the artifact is absent or its gate was not kept, the identity
     * is used — an unvalidated calibrator is never applied.
     */
    calibration: {
      enabled: true,
      // Relative to the backend directory; committed so production serves it.
      file: 'data/live-calibrator.json',
      method: 'isotonic',
      minSamples: 150,
      market: 'home_win',
    },

    /**
     * Phase 10 round D — PROBABILITY CLIP.
     *
     * Every scored and displayed probability (the frozen shadow candidates and
     * the shipped production column) is clipped to this inclusive band, so no
     * candidate can ever emit a literal 0 or 1: a 1-in-1000 event that never
     * happens in the sample must still leave the model room to be wrong. Applied
     * at READ/SCORE time — the frozen artifacts themselves are never rewritten
     * (a refit would move their ids, which are frozen for the confirmation run).
     */
    probabilityClip: { lower: 0.01, upper: 0.99 },

    /**
     * Phase 10 round F — SHADOW SWEEP HEALTH.
     *
     * The sweep runs on an in-process node-cron tick. Until now it recorded
     * nothing about whether it had run, so a sleeping host, a restarted process
     * and a matcher that throws every tick all looked identical to a healthy but
     * quiet scheduler. services/live/shadowHealth writes a small state file
     * after every sweep so /api/live/stats can report the last run, the error
     * count and the last error, and raise an alert when live games are being
     * served but no row is landing.
     *
     * All of these are REPORTING thresholds — they gate nothing.
     */
    health: {
      // Relative to the backend directory; survives a restart of the process.
      file: 'data/live-shadow-health.json',
      // The sweep cadence is 5 min; a last run older than this means the
      // scheduler is NOT ticking (the host is asleep, or the cron never started).
      staleAfterMs: 15 * 60 * 1000,
      // How recently live games must have been observed for the "no rows while
      // live" alert to be meaningful. Outside this window a quiet log is normal.
      liveWindowMs: 6 * 60 * 60 * 1000,
      // The alert fires when no shadow row has been logged for this long while
      // live games were seen within `liveWindowMs`.
      noRowAlertMs: 6 * 60 * 60 * 1000,
    },

    /**
     * Phase 10 round G — STORAGE ADAPTER.
     *
     * Shadow rows, settle outcomes, health state and the evaluation ledger all
     * persist through ONE interface (services/live/store) with two
     * implementations selected by `kind` (or LIVE_STORE_KIND):
     *   - 'file'      : the backend-local JSON files — tests and local dev;
     *   - 'firestore' : the existing Firebase admin setup — production, so the
     *                   evidence survives a sleeping host and its ephemeral disk.
     *
     * The file backend keeps the EXISTING paths (forwardTest.file / health.file)
     * so the committed artifacts, the frozen candidate ids and the criteria id
     * do not move when this adapter is introduced.
     */
    store: {
      kind: process.env.LIVE_STORE_KIND || 'file',
      // The evaluation ledger ("how many times each window has been SCORED").
      // Kept separate from the rows so a scored count is never conflated with
      // evidence. Relative to the backend directory.
      ledger: { file: 'data/live-ledger.json' },
      // Firestore layout when kind === 'firestore'. ONE collection holds a meta
      // document, a health document, a ledger document and a `rows`
      // subcollection. A row document id IS the storage key
      // (sport|league|game|grid_checkpoint), so a retry or a double sweep
      // OVERWRITES the same document instead of appending a second row.
      firestore: {
        collection: 'live_shadow',
        rowsSubcollection: 'rows',
        // Round I — Firestore cannot hang a subcollection off a COLLECTION, so
        // the rows live under this fixed PARENT document inside `live_shadow`:
        //   live_shadow/<rowsParentDoc>/rows/<rowId>
        // The parent document is never written, so it holds no data and never
        // appears in a listing of `live_shadow`; it exists only to own the
        // `rows` subcollection. The security rule `live_shadow/{document=**}`
        // already covers this nested path.
        rowsParentDoc: 'container',
        metaDoc: 'meta',
        healthDoc: 'health',
        ledgerDoc: 'ledger',
      },
      // A shadow row is stored ONLY when its elapsed fraction lands within this
      // of a REPLAY grid mark; any other row is skipped. This is the same
      // tolerance resampleToGrid uses, so what is written is what is scored.
      gridTolerance: 0.03,
      // POST /api/live/sweep hardening. `maxGamesPerCall` bounds one call so a
      // sweep always returns well inside the host's request timeout, reporting
      // `truncated:true` and letting the next call continue.
      sweep: {
        maxGamesPerCall: 12,
        rateLimit: { windowMs: 60 * 1000, perIp: 6 },
      },
      // Round H (item 2) — the sweep/stats secret. Accepted ONLY from the
      // `Authorization: Bearer <secret>` header, never a query string or a
      // request body (both leak into logs, proxies and referrers), and never
      // logged. A secret that is ABSENT or shorter than `minLength` is refused
      // (401) rather than leaving the route open: an endpoint that writes
      // evidence must fail closed. `env` falls back to `fallbackEnv` so an
      // existing settlement deployment needs no new variable.
      secret: {
        env: 'LIVE_STATS_SECRET',
        fallbackEnv: 'SETTLEMENT_CRON_SECRET',
        minLength: 24,
      },
      // Round H (item 3) — /api/live/stats re-reads DURABLE state (the scheduler
      // health document) on every poll. Cache those durable reads for this long
      // (ms) so a burst of polling does not multiply Firestore reads. 0 disables
      // the cache (every poll reads storage).
      stats: { cacheTtlMs: 5000 },
    },

    /**
     * Phase 9 — forward test.
     *
     * Every served live probability is logged with its timestamp, the data
     * staleness and (once known) its outcome. The pick is auto-DISABLED when the
     * realised log loss drifts past the backtest by `logLossTolerance` over the
     * last `window` settled games, and it is only opened to everyone after
     * `minGames` settled live games confirm the backtest.
     */
    forwardTest: {
      enabled: true,
      // Relative to the backend directory; survives restarts.
      file: 'data/live-forward.json',
      // Rolling auto-disable window, in SETTLED games.
      window: 300,
      // Minimum graded rows before any verdict (below this: no verdict).
      minEvaluated: 30,
      // Open to every user only after this many settled live games.
      minGames: 300,
      // Realised log loss may exceed the backtest by at most this.
      logLossTolerance: 0.02,
      // Cap rows kept per game so a long watch cannot dominate the sample.
      maxRowsPerGame: 20,
      // Cap the whole log so the file cannot grow without bound (oldest dropped).
      maxRows: 5000,
      // At most one disk write per this many ms while serving; a settle always
      // writes through. A crash can therefore lose at most this much append time.
      persistIntervalMs: 3000,
      // How long an auto-disable verdict is reused before it is recomputed.
      verdictTtlMs: 30 * 1000,
    },

    /**
     * Phase 9 — FROZEN release criteria (the shadow hold).
     *
     * These are the numbers that decide when basketball's live WINNER
     * probability may leave shadow and ship. They are frozen BEFORE any shadow
     * row exists: once the first shadow row is written, every later row records
     * the `criteria_id` (a content hash of this block) it was collected under,
     * so a mid-collection edit is detectable (`shadowSummary.criteria_moved`)
     * instead of silently moving the goalposts.
     *
     * Changing any value here AFTER shadow collection has begun invalidates the
     * run — the evidence gathered under the old criteria no longer answers the
     * new question. Deliberately bring the benchmark in from the fit script
     * (`forwardTest.benchmarkLogLoss`) rather than re-deriving it.
     *
     * The hold is released only when, on settled shadow GAMES:
     *   - `benchmarkLogLoss` is within `logLossTolerance` (compared on the
     *     last `forwardTest.window` settled games), AND
     *   - at least `minSettledGames` settled games have landed, AND
     *   - each bucket (`buckets.labels`) with `>= buckets.minGames` games is
     *     within `buckets.tolerance` of the benchmark, AND
     *   - each league with `>= perLeague.minGames` settled games is within
     *     `perLeague.tolerance` (the per-league sanity check), AND
     *   - the 95% game-level interval for the log-loss gain over the
     *     score-and-time baseline (`vsScoreTime.logLossGain`) has a lower bound
     *     >= `scoreTimeGain.minLogLossGainCiLower` (0).
     *
     * AMENDMENT 1 — 2026-11-08, recorded BEFORE any shadow row settled (see
     * `amendments`). `logLossTolerance` is 0.02 while the model's whole gain
     * over scoreTime is smaller than that, so matching the 0.4303 benchmark is
     * NOT by itself evidence the model adds anything over "score and time only".
     * The added clause closes that hole: the gain's interval must exclude zero.
     * This is a dated amendment to the frozen block, not an edit to it — the
     * prior id is kept, and every row carries both (`criteria_id` = this id in
     * force, `criteria_id_prior` = the id it superseded).
     */
    releaseCriteria: {
      // The date these numbers were fixed. Never edited without a new run.
      frozen_at: '2026-11-08',
      // Basketball's shipped test-window log loss — the forward-test benchmark.
      benchmarkLogLoss: 0.4303,
      // Realised log loss may exceed the benchmark by at most this.
      logLossTolerance: 0.02,
      // Minimum SETTLED GAMES (not checkpoints) before the hold can be released.
      minSettledGames: 300,
      // Confidence level for the reported log-loss intervals.
      confidence: 0.95,
      // Percentile bootstrap over whole games (see forwardTest.shadowSummary).
      bootstrap: { iterations: 2000, seed: 11 },
      // Per time-bucket sanity: early / mid / late, by elapsed fraction.
      buckets: { labels: ['early', 'mid', 'late'], minGames: 50, tolerance: 0.05 },
      // Per-league sanity: a league with >= minGames settled games must be
      // within tolerance of the benchmark on its own.
      perLeague: { minGames: 50, tolerance: 0.05 },
      // AMENDMENT 1 (structural): the 95% game-level log-loss-gain-vs-scoreTime
      // interval lower bound must be >= this. 0 means "the gain must exclude
      // zero". Hashed into criteriaId (unlike `amendments`, which is prose).
      scoreTimeGain: { minLogLossGainCiLower: 0 },
      // Dated amendment record. Documentation only — not hashed, so editing a
      // note cannot silently change the gate. `prior_criteria_id` is the frozen
      // id this amendment superseded.
      amendments: [
        {
          at: '2026-11-08',
          prior_criteria_id: '67d4708fea1d',
          change: 'require scoreTimeGain.minLogLossGainCiLower = 0 (log-loss-gain CI lower bound vs scoreTime must be >= 0)',
          note: 'The 0.02 log-loss tolerance vs the 0.4303 benchmark is larger than the model\'s total gain over scoreTime, so the benchmark clause alone does not prove the model adds anything. Recorded before any shadow row settled.',
        },
      ],
    },

    /**
     * Phase 10 round F — PER-LEAGUE RELEASE PRE-REGISTRATION.
     *
     * Release is PER LEAGUE, not per sport. `live.picks` is a league allowlist,
     * so adding one league to `live.picks.basketball` ships that league and
     * leaves every other league showing score, time and context only. This block
     * fixes the RULE by which a league is added to that list — NOW, while the
     * confirmation dataset still holds 0 settled games — so the rule cannot be
     * chosen to fit the result.
     *
     * A basketball league is released INDIVIDUALLY only when, on the CONFIRMATION
     * dataset (shadow rows logged strictly after the candidate freeze), ALL hold:
     *   1. it carries >= `minGames` settled games;
     *   2. its mean predicted P(home) is within `calibrationTolerance` of its
     *      realised home-win rate (absolute calibration, on the same rows); AND
     *   3. its own 95% game-level log-loss gain over scoreTime has a lower bound
     *      >= `scoreTimeGain.minLogLossGainCiLower`.
     * Clause 3 reuses the same whole-game bootstrap the ship gate uses, so the
     * per-league verdict is measured on the same ruler.
     *
     * This is a SEPARATE frozen block from `releaseCriteria`, deliberately: the
     * release-criteria id (7a32cb237260) is hashed from `releaseCriteria` alone
     * and is frozen for the current confirmation run. Pre-registering the
     * per-league rule here does NOT move that id.
     *
     * CBB observation — recorded 2026-11-14, NOT tuned. At the first checkpoint
     * (102 games) the frozen logistic scores mean P(home) 0.7475 against a
     * realised home-win rate of 0.8922. A first-checkpoint gap of that size is
     * consistent with LEGACY-SEASON (pregame) strength selection in the sampled
     * games rather than with live leakage — the state at minute one carries
     * almost no in-game information. It is recorded so the confirmation run's
     * per-league verdict can be read against it, and NOT acted on: no parameter
     * is changed and no league is pre-cleared or pre-rejected.
     */
    perLeagueRelease: {
      frozen_at: '2026-11-14',
      // Minimum settled GAMES in one league before its own verdict is computed.
      minGames: 100,
      // Absolute-calibration tolerance: |mean predicted - realised| must be <= this.
      calibrationTolerance: 0.05,
      // The league's own log-loss-gain-vs-scoreTime 95% interval lower bound.
      scoreTimeGain: { minLogLossGainCiLower: 0 },
      // Every known basketball league is listed so a league that has not been
      // run is visibly WITHHELD rather than silently absent from the report.
      leagues: ['nba', 'wnba', 'ncaa'],
      // Populated ONLY by the one-shot confirmation run, league by league.
      released: [],
      note: 'Withheld leagues show score/time/context only. Nothing is released by this block; it fixes the rule the confirmation run will apply.',
    },

    /**
     * Live matches — external score-site feed (FlashScore / LiveScore).
     *
     * This is a SEPARATE surface from the bookmaker-link parser above: here the
     * server itself reads two public score sites to list which games are IN PLAY
     * right now. It fetches no odds and stores nothing — the list is built on
     * demand, cached for a few seconds and handed to the client, which may then
     * open any match (or its own preferred streaming link) in an in-app browser.
     *
     * `sites` is the allow-list of hosts a user may save as a preferred link and
     * open. A link to any other http(s) host is still accepted but reported as
     * unrecognised, never as valid-and-known.
     */
    matchFeed: {
      enabled: true,
      // Short cache so a burst of client polls shares one upstream read per source.
      cacheTtlMs: 20 * 1000,
      // Per-request upstream timeout; a slow source is reported as failed, not fatal.
      requestTimeoutMs: 12 * 1000,
      // Cap the live list handed to one client (highest-freshness games first).
      maxMatches: 150,
      // Auto-refresh hint for the client, in seconds.
      refresh: { suggestedSeconds: 30, minSeconds: 15 },
      // Hosts a user may save as a preferred link. Suffix-matched, so
      // 'm.flashscore.com' and 'www.livescore.com' both resolve.
      sites: [
        { id: 'flashscore', name: 'FlashScore', host: 'flashscore.com', home: 'https://m.flashscore.com/' },
        { id: 'livescore', name: 'LiveScore', host: 'livescore.com', home: 'https://www.livescore.com/en/' },
      ],
      // Per-source switches. A disabled source is skipped, not reported as failed.
      sources: {
        livescore: { enabled: true, sports: ['soccer', 'basketball'] },
        flashscore: { enabled: true, sports: ['soccer', 'basketball'] },
      },
      /**
       * LEAGUE IDENTITY — the bridge from a score-site's league NAME to the ESPN
       * league id the ship gate keys on.
       *
       * Both sites publish only a competition NAME ("Premier League", "NBA"),
       * never the ESPN id the gate compares against. Without this map a listed
       * game carries `league.id = null` and can NEVER clear the gate — even for a
       * league that has been released — so "no final-outcome prediction" is a
       * structural dead end rather than a policy refusal.
       *
       * Values are the ESPN league slugs already used across the product (see the
       * matcher `sweep` above and the app's league catalogue). A name that is not
       * listed resolves to null: it is left UNKNOWN rather than guessed, so an
       * unrecognised competition is honestly withheld instead of mis-labelled.
       * Populating this never releases a pick — the ship gate still decides.
       */
      leagueIds: {
        soccer: {
          'Premier League': 'eng.1',
          'Championship': 'eng.2',
          'League One': 'eng.3',
          'League Two': 'eng.4',
          'La Liga': 'esp.1',
          'La Liga 2': 'esp.2',
          'Segunda División': 'esp.2',
          'Serie A': 'ita.1',
          'Serie B': 'ita.2',
          'Bundesliga': 'ger.1',
          '2. Bundesliga': 'ger.2',
          'Eredivisie': 'ned.1',
          'Eerste Divisie': 'ned.2',
          'Liga Portugal': 'por.1',
          'Primeira Liga': 'por.1',
          'Liga Portugal 2': 'por.2',
          'Super Lig': 'tur.1',
          'Russian Premier League': 'rus.1',
          'Ukrainian Premier League': 'ukr.1',
          'Belgian Pro League': 'bel.1',
          'Scottish Premiership': 'sct.1',
          'Scottish Championship': 'sct.2',
          'Austrian Bundesliga': 'aut.1',
          'Super League Greece': 'grc.1',
          'Danish Superliga': 'dnk.1',
          'Allsvenskan': 'swe.1',
          'Eliteserien': 'nor.1',
          'Czech First League': 'cze.1',
          'Liga MX': 'mex.1',
          'Brasileirão Série A': 'bra.1',
          'MLS': 'usa.1',
          'J1 League': 'jpn.1',
          'K League 1': 'kor.1',
          'Chinese Super League': 'chn.1',
          'Saudi Pro League': 'saudi.1',
          'Copa Libertadores': 'conmebol.libertadores',
          'Champions League': 'uefa.champions',
          'UEFA Champions League': 'uefa.champions',
          'Europa League': 'uefa.europa',
          'UEFA Europa League': 'uefa.europa',
          'Europa Conference League': 'uefa.europaconference',
        },
        basketball: {
          'NBA': 'nba',
          'WNBA': 'wnba',
          'NCAA Men': 'mens-college-basketball',
          'NCAA Women': 'womens-college-basketball',
          'EuroLeague': 'euroleague',
          'EuroCup': 'eurocup',
          'Liga ACB (Spain)': 'acb',
        },
      },
      /**
       * Transient-failure retry for each upstream read. Only network errors,
       * timeouts (aborts) and 5xx/429 responses are retried; a 4xx is a request
       * problem and is reported straight away. Backoff is exponential, capped at
       * `maxDelayMs`.
       */
      retry: { attempts: 3, baseDelayMs: 400, maxDelayMs: 2000 },
      /**
       * Live predictions for the listed games. Each normalised match is adapted
       * into the SAME Phase 3 LiveGame the rest of the engine consumes and run
       * through the Phase 4 model, then gated by the Phase 5 ship gate — so a
       * probability only appears where the rest of the product would show one.
       * This is a sub-switch: the list still works when predictions are off.
       */
      predictions: { enabled: true },
    },
  },

  /**
   * Phase 6 — HTTP surface. Every knob the routes use lives here.
   */
  liveApi: {
    // A game that was resolved is kept this long so `/analysis` can be polled
    // without re-matching. After this the client must resolve again.
    gameTtlMs: 4 * 60 * 60 * 1000,
    // A finished analysis payload is shared across every user watching the same
    // game for this long — this is what stops the UI from hammering the API.
    analysisTtlMs: 30 * 1000,
    // Max stored games before the oldest entries are evicted.
    maxCachedGames: 500,
    // Auto-refresh hint handed to the UI, in seconds.
    refresh: { suggestedSeconds: 30, minSeconds: 15 },
    /**
     * Phase 9 — context-only experience. The live path adds a cached ESPN
     * match-summary read so the UI can show key events and injuries; nothing
     * here feeds a probability. The TTL is short because key events change while
     * a game is running, and the read is best-effort (a failure degrades to the
     * pre-game context only).
     */
    contextTtlMs: 60 * 1000,
    context: { maxKeyEvents: 6, maxInjuries: 8 },
    rateLimit: {
      windowMs: 60 * 1000,
      // Requests per window per client IP, and per authenticated user id.
      perIp: 30,
      perUser: 60,
    },
    // Manual entry gets a stricter, separate budget: it is cheap for us but easy
    // to hammer, and a typed game can never ship a probability anyway.
    manualRateLimit: {
      windowMs: 60 * 1000,
      perIp: 10,
      perUser: 20,
    },
    // The badge every hand-typed analysis carries, everywhere it appears —
    // including any share or export text. It is never omitted.
    manualBadge: 'User-entered, unverified',
    manualDisclaimer:
      'These values were typed in by hand and were not checked against a provider. '
      + 'This game is shown for context only and is excluded from our accuracy statistics.',
    maxLinkLength: 2048,
    // Emit the non-personal aggregation counters (match success, manual-entry
    // rate, parse failures, bookmaker domains).
    recordStats: true,
    disclaimer:
      'Live estimates are statistical model outputs, not betting advice. '
      + 'No outcome is guaranteed. Where the model has not passed backtesting, '
      + 'no probability is shown at all.',
  },

  /**
   * Phase 1 — link parsing.
   *
   * `confidence.byKind` scores each parser rule kind. A rule carries its `kind`
   * only, so adding a new bookmaker pattern of an existing kind is a pure data
   * change in ./linkPatterns.js.
   */
  linkParser: {
    maxUrlLength: 2048,
    maxNotes: 16,
    // A single hyphen-glued slug is only split when both halves resolve through
    // the alias table; cap the tokens we are willing to explore.
    maxSlugTokens: 10,
    // Minimum alphabetical characters in a slug before we consider it a team.
    minTeamSlugLetters: 3,
    // Opaque match ids are stripped from the head/tail of the final path segment.
    idTokenMinDigits: 3,
    // Confidence attached to a recognised LiveScore / FlashScore MATCH page: the
    // game is identified from its own canonical match id, so no team-name
    // guesswork is involved.
    platformConfidence: 0.99,
    confidence: {
      byKind: {
        'query-explicit': 0.95,
        'query-teams': 0.92,
        'path-separator': 0.9,
        'path-adjacent': 0.72,
        'path-glued': 0.6,
      },
      sportKnownBonus: 0.03,
      leagueHintBonus: 0.03,
      bothTeamsAliasMatchedBonus: 0.04,
      oneTeamAliasMatchedBonus: 0.02,
      // Bare "football" is a genuine ambiguity (soccer vs American football).
      bareFootballPenalty: 0.05,
      // Applied when a strong rule (path-separator) yields two names that are
      // NOT in the alias table. Sized so that even with the sport and league
      // bonuses an unresolved pair stays out of the "high" tier — we do not
      // claim high confidence we have not earned.
      unresolvedTeamsPenalty: 0.25,
      min: 0.05,
      max: 0.99,
    },
    // Phase 2 matching thresholds, defined here so parser and matcher agree.
    tiers: { high: 0.75, medium: 0.5 },
  },

  /**
   * Phase 2 — live game matching.
   *
   * The matcher sweeps ESPN scoreboards (then Pitch, soccer only) and scores
   * every fixture against the two team names the parser extracted. Every knob
   * below is intentionally here rather than in code.
   *
   * `sweep` lists ESPN league segments per sport, most likely first. French
   * competitions are deliberately absent: providers/normalizer excludes them
   * for product reasons, so sweeping them would only waste a request.
   * EuroLeague ('eur') is also absent — ESPN returns zero events for it.
   */
  matcher: {
    // Short TTL: live scores and clocks change fast. Overrides the provider's
    // 30-minute scheduled-fixtures TTL for scoreboard reads.
    cacheTtlMs: 45 * 1000,
    maxConcurrency: 6,
    maxCandidates: 3,
    // A candidate must clear BOTH side similarities; a link that only matches
    // one team is not enough to assume the other.
    minSideSimilarity: 0.5,
    // How far around "now" a non-live fixture is still worth considering.
    window: { preHours: 6, postHours: 3 },
    includeStatuses: ['live', 'scheduled', 'finished'],
    // Match-confidence gates.
    tiers: { high: 0.82, medium: 0.55 },
    // Small, honest bonuses on top of the name similarity.
    leagueHintBonus: 0.05,
    liveBonus: 0.03,
    maxConfidence: 0.99,
    sweep: {
      soccer: [
        'eng.1', 'esp.1', 'ita.1', 'ger.1', 'uefa.champions', 'uefa.europa',
        'eng.2', 'esp.2', 'ita.2', 'ger.2', 'ned.1', 'por.1', 'tur.1',
        'sco.1', 'usa.1', 'mex.1', 'bra.1',
      ],
      basketball: ['nba', 'wnba', 'mens-college-basketball'],
    },
    // Pitch fallback (soccer only). It has no clock/period, so it is a
    // last-resort source for identification, never for live state.
    pitchFallback: { enabled: true, daySpan: 1 },
  },

  /**
   * Phase 3 — unified LiveGame object, data tiers, staleness and manual entry.
   *
   * `tierLabels` are the exact strings the UI shows. The tier itself is decided
   * from what the provider actually gave us (score? in-game clock? period?), so
   * a lower tier is never dressed up as "full live data".
   */
  liveGame: {
    tierLabels: {
      full_live: 'Full live data',
      score_time_only: 'Score and time only',
      user_entered: 'User-entered',
    },
    // Beyond this age the payload is flagged stale in the UI.
    staleAfterSeconds: 120,
    // A clock is only "usable" when it has a display value; basketball also
    // needs a period for the tier to count as full live data.
    requirePeriodForFullLive: true,
    manual: {
      minNameLetters: 3,
      maxNameLength: 60,
      // Global fallbacks; `sports` below overrides them per sport.
      maxScore: 250,
      maxPeriod: 10,
      // Accepts soccer ("34'", "90+4'") and basketball ("7:24") clocks.
      clockPattern: "^\\d{1,3}(\\+\\d{1,2})?(:[0-5]\\d)?'?$",
      /**
       * Phase 7 — per-sport rules. Ranges and score/time consistency are checked
       * against these, so an impossible game is refused instead of modelled.
       */
      sports: {
        soccer: {
          maxScore: 30,
          maxPeriods: 2,
          regulationMinutes: 90,
          halfLengthMinutes: 45,
          // A clock may run this far past the end (or the half) before it is
          // judged impossible.
          maxStoppageMinutes: 15,
        },
        basketball: {
          maxScore: 250,
          maxPeriods: 10,
          // The longest a basketball period can be (NCAA halves are 20 min).
          // Only applied to a "mm:ss" clock.
          maxPeriodMinutes: 20,
          // A live basketball game needs a period, or the remaining-points
          // model has nothing to count down from.
          requirePeriodWhenLive: true,
        },
      },
    },
  },

  /**
   * Phase 4 — live probability models.
   *
   * Both models project the REMAINING scoring and add it to the current score,
   * so at kick-off the output equals the pre-game projection (no discontinuity
   * as the game starts). Parameters below are documented priors; Phase 5 fits
   * and validates them against ESPN history. Nothing is invented at run time.
   *
   * `tierWeight` is how far the live estimate is trusted against the pre-game
   * prior: a lower-tier (less complete or unverified) live state is pulled back
   * toward the prior rather than taken at face value.
   */
  liveModel: {
    // Confidence level for the reported uncertainty bands (0.8 -> p10/p90).
    uncertaintyLevel: 0.8,
    tierWeight: {
      full_live: 1.0,
      score_time_only: 0.5,
      user_entered: 0.35,
    },

    /**
     * Phase 7 — the extra conservatism hand-typed games get on top of their
     * tier weight. A typed score is pulled further toward the pre-game prior
     * and its uncertainty bands are stretched, because nothing about it has
     * been verified.
     */
    manual: {
      extraShrink: 0.5,
      uncertaintyWiden: 1.6,
    },

    soccer: {
      regulationMinutes: 90,
      // Poisson truncation for remaining goals per side.
      maxRemainingGoals: 8,
      // Full-match expected goals per side (league-neutral baseline).
      baseHomeGoals: 1.55,
      baseAwayGoals: 1.25,
      // Dixon-Coles low-score dependence.
      rho: -0.05,
      // A trailing side attacks more, a leading side less; multiplier per goal.
      scoreEffect: { trailingBoost: 0.18, leadingDrag: 0.1, max: 1.8, min: 0.55 },
      // Each red card shifts the goal-rate split toward the other side.
      redCard: { rateShift: 0.35, maxShift: 0.6 },
      // Blend the observed shots-on-target share into the rate split.
      shotPressure: { weight: 0.25, minShots: 6 },

      // --- Live-statistics engine (liveStats.js -> context.stats) ---
      // Weighted threat share over available components; tilts the
      // home/away rate split without changing the combined goal rate.
      threatShare: {
        weight: 0.35,
        minEvidence: 4,
        components: {
          shots_on_target: 0.4,
          shots: 0.2,
          corners: 0.2,
          possession_pct: 0.1,
          passes: 0.1,
        },
      },
      // Goal-rate calibration: scale both remaining-goal rates toward the
      // observed scoring tempo once enough of the match has elapsed.
      tempo: { minElapsed: 20, weight: 0.5, scaleMin: 0.8, scaleMax: 1.3 },
      // Momentum tilt from recorded stat snapshots (bounded).
      momentum: { maxTilt: 0.08 },
    },

    basketball: {
      defaultPeriods: 4,
      // Periods per league, so period length = gameMinutes / periods
      // (NCAA is two 20-minute halves, the pros four quarters).
      leaguePeriods: { nba: 4, wnba: 4, ncaa: 2, euroleague: 4 },
      overtimeMinutes: 5,
      // Used only when the league is unknown to basketball/leagues.js.
      fallback: {
        gameMinutes: 48, totalMean: 220, totalStd: 18, marginStd: 12, homeCourtPoints: 2.5,
      },
      // Final minutes: deliberate fouling lifts both scoring rate and variance.
      endgame: { minutes: 2, rateMultiplier: 1.15, sigmaMultiplier: 1.35 },
    },
  },

  /**
   * Phase 5 — hard validation gate.
   *
   * Replays ESPN history through the Phase 4 models at leakage-free in-game
   * checkpoints and asks a single question per sport (and per league): does the
   * live probability beat the de-vigged market on held-out games by more than
   * noise? Nothing here is a target to hit — it is the bar a model must clear
   * before any live *pick* is shown. The projection is always allowed.
   *
   * `checkpoints` says which in-game states are replayed. Every checkpoint is
   * built ONLY from plays/events at or before that moment, so the replay cannot
   * see its own future.
   */
  liveBacktest: {
    checkpoints: {
      basketball: {
        // State snapshots at these fractions of REGULATION elapsed. The SAME
        // grid is applied to every league, so a 2x20 game (college) is sampled at
        // the same early/mid/late points as a 4x12 game (NBA). The per-period
        // clock mark is derived from the league's own period structure
        // (periods x periodMinutes, see ./replay basketballStructure): for
        // fraction f the target is period floor(f*P)+1 with clock
        // periodMinutes - (f*P*periodMinutes - (period-1)*periodMinutes).
        //
        // This 11-point grid is exactly the legacy NBA 4x12 in-period [6, 3, 0]
        // marks expressed as elapsed fractions: 6/48, 9/48, 12/48, 18/48, 21/48,
        // 24/48, 30/48, 33/48, 36/48, 42/48, 45/48. NBA sampling is therefore
        // UNCHANGED; only the other leagues move onto the same grid. Under
        // bucketEdges [0.3333, 0.6667] it gives every league 3 early / 4 mid /
        // 4 late checkpoints per game (when the plays are present).
        fractions: [0.125, 0.1875, 0.25, 0.375, 0.4375, 0.5, 0.625, 0.6875, 0.75, 0.875, 0.9375],
        // Legacy per-period "minutes remaining" marks. Still honoured when a
        // caller passes them explicitly (unit fixtures, the synthetic smoke
        // test); a 0 mark is the period end and is skipped for the final period
        // (there the game is already decided). The production replay uses the
        // elapsed-fraction grid above instead.
        minutesRemaining: [6, 3, 0],
      },
      soccer: {
        // State snapshots at these cumulative match minutes.
        minutes: [15, 30, 45, 60, 75],
      },
    },

    // Chronological walk-forward split (fractions of the ordered game list).
    windows: { train: [0, 0.6], validation: [0.6, 0.8], test: [0.8, 1.0] },
    // The walk-forward calibrator is refitted every N games, from strictly
    // earlier games only.
    refitEvery: 25,

    // Calibration gate — mirrors basketball/calibration.validateAgainstIdentity.
    calibration: {
      method: 'isotonic',
      minSamples: 150,
      minImprovementBrier: 0.002,
      minImprovementLogLoss: 0.002,
      requireMonotone: true,
    },

    /**
     * Ship gate — a live PICK is only enabled when EVERY clause passes on the
     * out-of-sample test window. Until then the UI shows the projection only.
     *
     * The gate counts GAMES, not checkpoint rows. A single game contributes
     * several checkpoints, and those checkpoints share one outcome, so counting
     * rows would let ten games masquerade as a hundred independent observations.
     * The confidence intervals come from a bootstrap that resamples WHOLE GAMES
     * (see ./backtester gameBootstrap) for the same reason.
     *
     * The reference is the score-and-time baseline. The pre-game (de-vigged)
     * line is NOT a reference: it is one price per game applied at every
     * checkpoint, so an in-game model beats it by construction — it is reported
     * for information only and compared against nothing.
     */
    shipGate: {
      minGames: 500,
      minImprovementBrier: 0.002,
      minImprovementLogLoss: 0.002,
      // Break-even win rate at -110.
      breakEvenProbability: 0.524,
      confidence: 0.95,
      // A single league needs this many graded test GAMES before its own numbers
      // are used as a sanity check against the sport-level result.
      minLeagueGames: 100,
      // Percentile bootstrap over whole games. `iterations` trades run time for
      // a smoother interval; `seed` keeps a report reproducible.
      bootstrap: { iterations: 2000, seed: 11 },
    },

    /**
     * Phase 10 — ABSOLUTE calibration gates.
     *
     * The ship gate above only asks whether a column BEATS the score-and-time
     * baseline; it says nothing about whether the column is itself calibrated
     * (does a stated 40% actually happen 40% of the time?). Phase 10 adds that
     * check for the score-and-time baseline itself, and for the soccer rewrite:
     * a reliability bucket with enough graded rows must have its realised rate
     * within `maxBucketDeviation` of its average prediction.
     *
     * A column "passes" only when EVERY judged bucket is inside the band. A
     * bucket below `minBucketGames` is not judged (absence of evidence is not a
     * pass). `minRows` is the minimum graded rows before a column or a league is
     * judged at all. These are read by scripts/run-live-phase10-report.js.
     */
    absoluteCalibration: {
      // A reliability bucket is judged once it holds at least this many rows.
      minBucketGames: 300,
      // A judged bucket's |mean predicted - realised rate| must not exceed this.
      maxBucketDeviation: 0.05,
      // Minimum graded rows before a column (or a by-league slice) is judged.
      minRows: 300,
    },

    /**
     * Time buckets. A checkpoint's bucket is decided by the fraction of the game
     * already played, so a near-decided late checkpoint is reported separately
     * instead of inflating the headline hit rate. `edges` are the upper bounds
     * of early and mid; anything beyond is late.
     */
    bucketEdges: [0.3333, 0.6667],
    bucketLabels: ['early', 'mid', 'late'],

    // Probability buckets for the reported calibration curve (home-win market).
    curveEdges: [0, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 1.01],
    // Below this many graded rows a checkpoint's metrics are indicative only.
    minCheckpointSamples: 30,
    // The naive baseline: a coin flip that ignores home advantage.
    naiveProbability: 0.5,

    /**
     * Baseline models, scored on exactly the same selections as the live model.
     *
     * `scoreTime` is the blunt baseline the Phase 5 brief names: extrapolate the
     * CURRENT score across the time remaining, knowing nothing about the teams,
     * the league or the score effect. It is deliberately weaker than the live
     * model, so it answers one question honestly — does the Phase 4 machinery
     * (score effect, red cards, shot pressure, home-court edge, league sigmas)
     * actually add anything over "the score is what it is, and there is this
     * much time left"? `prior` covers the other named baseline (pre-game only).
     *
     * Every constant here is global on purpose: a baseline that borrowed league
     * fits would no longer be a baseline.
     */
    baselines: {
      scoreTime: {
        basketball: {
          gameMinutes: 48,
          periods: 4,
          overtimeMinutes: 5,
          // Global pre-game close-margin sigma; the baseline has no league fit.
          fullMarginSigma: 12,
        },
        soccer: {
          regulationMinutes: 90,
          // Same documented full-match priors as liveModel.soccer, no adjustments.
          fullHomeGoals: 1.55,
          fullAwayGoals: 1.25,
          maxRemainingGoals: 8,
        },
      },
    },

    /**
     * Dataset acquisition (Phase 8). The replay sweep reads a lot of ESPN
     * history, so every scoreboard/summary response is cached on disk and the
     * outbound rate is throttled with backoff. The cache makes a long sweep
     * resumable: re-running skips everything already fetched.
     */
    dataset: {
      // Relative to the backend directory. Never commit it (see .gitignore).
      cacheDir: 'data/live-cache',
      // Concurrent in-flight requests.
      concurrency: 4,
      // Minimum gap between the START of two outbound requests (throttle).
      minIntervalMs: 60,
      // Retries per request, with exponential backoff.
      retries: 3,
      backoffMs: 1000,
      requestTimeoutMs: 20000,
      // Cap on replayable games kept per (league, season).
      maxEventsPerLeague: 900,
      // How many upstream reads to run before flushing the provider's
      // in-process response cache. That cache is unbounded and sized for a
      // server's 30-minute horizon; a two-season replay makes tens of thousands
      // of reads and would exhaust the heap. The disk cache above already makes
      // a repeat read free, so flushing costs no extra network traffic.
      cacheFlushEvery: 500,
    },

    /**
     * Seasons swept per sport, as inclusive ESPN scoreboard date ranges
     * (YYYYMMDD). Basketball and soccer run on different calendars, so the
     * ranges are per sport. `label` is what the coverage report prints.
     *
     * A range may carry `leagues` to scope it to specific league codes, for a
     * competition whose season does not sit on the sport's default calendar.
     * The WNBA plays May–September, so the NBA/CBB window (Oct–Apr) contains no
     * WNBA games; without its own window the WNBA sweep silently returns none.
     */
    seasons: {
      basketball: [
        { label: '2025-26', from: '20251021', to: '20260412' },
        { label: '2024-25', from: '20241022', to: '20250413' },
        // WNBA regular season + finals (May–Sep).
        { label: '2025', from: '20250501', to: '20250930', leagues: ['wnba'] },
        { label: '2024', from: '20240501', to: '20241031', leagues: ['wnba'] },
      ],
      soccer: [
        { label: '2025-26', from: '20250801', to: '20260531' },
        { label: '2024-25', from: '20240801', to: '20250531' },
      ],
    },
  },
};

module.exports = CONFIG;
