/**
 * Phase 10 round H (item 1) — the WHOLE-SUITE `data/` guard (setup half).
 *
 * Snapshot backend/data/ before the suite runs; tests/global-teardown.js
 * compares it afterwards and fails the run if anything changed. See
 * tests/global-teardown.js for the full rationale.
 */
module.exports = async () => {
  require('./global-teardown').snapshot();
};
