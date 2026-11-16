/**
 * Round J (item 2) — the Firestore SECURITY RULES, exercised against the
 * emulator with `@firebase/rules-unit-testing`.
 *
 * Two things are proven here:
 *
 *   1. `live_shadow/**` is SERVER-ONLY. The shadow evidence (the `rows`
 *      subcollection under the fixed `container` parent, plus the `meta`,
 *      `health` and `ledger` documents) is written ONLY by the backend through
 *      the Firebase Admin SDK, which bypasses these rules. No CLIENT — signed in
 *      or anonymous — may read or write any of it. This test asserts that an
 *      UNAUTHENTICATED client and an AUTHENTICATED client are both DENIED.
 *
 *   2. The pre-existing `users` rules still behave exactly as before. This round
 *      only ADDS the `live_shadow` deny; it must not have changed who may read a
 *      profile, create their own, or perform the atomic token transfer.
 *
 * These tests RUN AGAINST THE EMULATOR and are skipped unless
 * FIRESTORE_EMULATOR_HOST is set, so a normal `npm test` (file backend) is
 * unaffected:
 *
 *   $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
 *   npx jest tests/firestore-rules.test.js
 */

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

// The deployed rules live at the repository root, beside firebase.json.
const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST || null;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-apex';
const [HOST, PORT_RAW] = (EMULATOR || '127.0.0.1:8080').split(':');
const PORT = Number(PORT_RAW) || 8080;

// Only run when the emulator is reachable via the standard env var.
const describeEmulator = EMULATOR ? describe : describe.skip;

// Every client-addressable node under live_shadow: the singleton documents and a
// representative row (its id IS the idempotency key, sport|league|game|grid —
// any '/' already folded to '_').
const LIVE_DOCS = [
  'live_shadow/meta',
  'live_shadow/health',
  'live_shadow/ledger',
  'live_shadow/container/rows/soccer|eng_1|401|98000',
];
const LIVE_ROWS_COLLECTION = 'live_shadow/container/rows';

describeEmulator('firestore.rules — live_shadow is server-only; users rules unchanged', () => {
  let testEnv;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules: RULES, host: HOST, port: PORT },
    });
  });

  afterAll(async () => {
    if (testEnv) await testEnv.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  /** An ANONYMOUS client (no auth token). */
  const anon = () => testEnv.unauthenticatedContext().firestore();
  /** An AUTHENTICATED client (a signed-in app user). */
  const authed = (uid = 'user_1') => testEnv.authenticatedContext(uid).firestore();

  /* ------------------------------------------------ item 2a: live_shadow deny */

  describe('live_shadow is denied to every client', () => {
    test('unauthenticated client cannot read or write any live_shadow node', async () => {
      const db = anon();
      for (const p of LIVE_DOCS) {
        await assertFails(db.doc(p).get());
        await assertFails(db.doc(p).set({ tampered: true }));
        await assertFails(db.doc(p).delete());
      }
      // A collection query is denied too (no read of the evidence in bulk).
      await assertFails(db.collection(LIVE_ROWS_COLLECTION).get());
      await assertFails(db.collection('live_shadow').get());
    });

    test('authenticated client cannot read or write any live_shadow node', async () => {
      const db = authed('user_1');
      for (const p of LIVE_DOCS) {
        await assertFails(db.doc(p).get());
        await assertFails(db.doc(p).set({ tampered: true }));
        await assertFails(db.doc(p).delete());
      }
      await assertFails(db.collection(LIVE_ROWS_COLLECTION).get());
      await assertFails(db.collection('live_shadow').get());
    });

    test('a write to live_shadow cannot be smuggled through a batch', async () => {
      const db = authed('user_1');
      const batch = db.batch();
      batch.set(db.doc('users/user_1'), { tokens: 1 });
      batch.set(db.doc('live_shadow/meta'), { tampered: true });
      await assertFails(batch.commit());
    });
  });

  /* ---------------------------------------------- item 2b: users rules intact */

  describe('users rules still pass their previous cases', () => {
    test('read: any signed-in user may read a profile; an anonymous one may not', async () => {
      await assertSucceeds(authed('reader').doc('users/someone').get());
      await assertFails(anon().doc('users/someone').get());
    });

    test('create: a user may create their OWN profile, not someone else\'s', async () => {
      await assertSucceeds(authed('user_1').doc('users/user_1').set({ tokens: 10 }));
      await assertFails(authed('user_1').doc('users/user_2').set({ tokens: 10 }));
      await assertFails(anon().doc('users/anon_1').set({ tokens: 10 }));
    });

    test('update: a user may update their OWN profile; an anonymous one may not', async () => {
      await assertSucceeds(authed('user_1').doc('users/user_1').set({ tokens: 10 }));
      await assertSucceeds(authed('user_1').doc('users/user_1').update({ tokens: 5 }));
      await assertFails(anon().doc('users/user_1').update({ tokens: 0 }));
    });

    test('update: the atomic token transfer is allowed only when both sides match', async () => {
      // Seed both wallets with the rules DISABLED (server-side setup).
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('users/sender').set({ tokens: 100 });
        await ctx.firestore().doc('users/recipient').set({ tokens: 50 });
      });

      // A balanced swap: sender -10, recipient +10 in ONE batch — allowed.
      const db = authed('sender');
      const balanced = db.batch();
      balanced.update(db.doc('users/sender'), { tokens: 90 });
      balanced.update(db.doc('users/recipient'), { tokens: 60 });
      await assertSucceeds(balanced.commit());

      // An UNBALANCED swap: recipient +10 but sender unchanged — denied.
      const db2 = authed('sender');
      const unbalanced = db2.batch();
      unbalanced.update(db2.doc('users/recipient'), { tokens: 70 });
      await assertFails(unbalanced.commit());
    });

    test('update: a non-token field cannot be changed on another user\'s profile', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('users/recipient').set({ tokens: 50, name: 'Recipient' });
      });
      // The transfer branch only permits the 'tokens' key to move.
      await assertFails(authed('sender').doc('users/recipient').update({ name: 'Hacked' }));
    });
  });
});
