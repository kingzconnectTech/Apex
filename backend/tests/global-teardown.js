/**
 * Phase 10 round H (item 1) — the WHOLE-SUITE `data/` guard (teardown half).
 *
 * The per-store guard in services/live/store/fileStore redirects the live
 * stores away from backend/data/ while NODE_ENV=test. This is the backstop that
 * fails the ENTIRE run if ANY file under backend/data/ changed while the suite
 * ran — including from a code path the store guard does not cover.
 *
 * tests/global-setup.js writes a manifest of data/ before the suite; this
 * compares it afterwards and throws (failing the run) on any add, remove or
 * edit. Both hooks are wired in package.json (`jest.globalSetup` /
 * `jest.globalTeardown`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MARKER = path.join(os.tmpdir(), 'apex-data-guard.json');

/** A content manifest of every regular file directly under `dir`. */
function manifest(dir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { return out; }
  names.sort();
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (!st.isFile()) continue;
    let sha1 = null;
    try { sha1 = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (err) { sha1 = null; }
    out[name] = { size: st.size, sha1 };
  }
  return out;
}

/** Snapshot data/ to the marker file (called by tests/global-setup.js). */
function snapshot() {
  // Clear any leftover marker from a run that crashed before its teardown, so a
  // stale manifest can never be mistaken for this run's baseline.
  try { fs.unlinkSync(MARKER); } catch (err) { /* absent is fine */ }
  fs.writeFileSync(MARKER, JSON.stringify({ data_dir: DATA_DIR, files: manifest(DATA_DIR) }));
}

/** Compare data/ to the snapshot and fail the run on any change. */
function verify() {
  let before = null;
  try { before = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (err) { return; }
  try { fs.unlinkSync(MARKER); } catch (err) { /* ignore */ }
  if (!before || before.data_dir !== DATA_DIR) return;

  const after = manifest(DATA_DIR);
  const files = before.files || {};
  const names = new Set([...Object.keys(files), ...Object.keys(after)]);
  const changed = [];
  for (const name of names) {
    const a = files[name];
    const b = after[name];
    if (!a || !b || a.size !== b.size || a.sha1 !== b.sha1) changed.push(name);
  }
  if (changed.length) {
    throw new Error(
      'Test isolation guard (round H item 1): files under backend/data/ changed during the test suite: '
      + changed.join(', ')
      + '. No test may write under backend/data/ — the live stores must redirect their paths to a temp dir '
      + '(services/live/store/fileStore, NODE_ENV=test guard).',
    );
  }
}

module.exports = verify;
module.exports.snapshot = snapshot;
module.exports.manifest = manifest;
module.exports.DATA_DIR = DATA_DIR;
