/**
 * admin_predictions Firestore SECURITY RULES, exercised against the emulator
 * with `@firebase/rules-unit-testing`.
 *
 * What this proves — the requirements for the Admin Predictions system:
 *   - a SIGNED-IN ORDINARY user may read PUBLISHED predictions only;
 *   - a non-admin can neither read a draft, nor create, edit or delete;
 *   - an ADMINISTRATOR (token claim `admin: true`) may do all of those;
 *   - ownership (`createdBy`) cannot be reassigned on update;
 *   - a malformed document (bad confidence, bad status) is refused;
 *   - a non-admin write cannot be smuggled through a batch.
 *
 * These tests RUN AGAINST THE EMULATOR and are skipped unless
 * FIRESTORE_EMULATOR_HOST is set, so a normal `npm test` (file backend) is
 * unaffected:
 *
 *   $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
 *   npx jest tests/admin-predictions-rules.test.js
 */

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST || null;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-apex';
const [HOST, PORT_RAW] = (EMULATOR || '127.0.0.1:8080').split(':');
const PORT = Number(PORT_RAW) || 8080;

const describeEmulator = EMULATOR ? describe : describe.skip;

/** A complete, rules-valid prediction document. */
function validPrediction(overrides = {}) {
  const now = new Date();
  return {
    sport: 'Football',
    league: 'Premier League',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    matchDate: now,
    market: 'Over/Under Goals',
    selection: 'Over 1.5 Goals',
    confidence: 92,
    analysis: 'Both sides are in scoring form.',
    status: 'pending',
    visibility: 'published',
    createdBy: 'admin_1',
    createdAt: now,
    updatedAt: now,
    settledBy: null,
    settledAt: null,
    ...overrides,
  };
}

describeEmulator('firestore.rules — admin_predictions are claims-gated', () => {
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

  const anon = () => testEnv.unauthenticatedContext().firestore();
  const user = (uid = 'user_1') => testEnv.authenticatedContext(uid).firestore();
  const adminDb = (uid = 'admin_1') => testEnv.authenticatedContext(uid, { admin: true }).firestore();

  /** Seed a document bypassing the rules (server-side setup). */
  async function seed(id, data) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`admin_predictions/${id}`).set(data);
    });
  }

  /* -------------------------------------------------- reads */

  test('an unauthenticated client cannot read or write anything', async () => {
    await seed('published', validPrediction());
    const db = anon();
    await assertFails(db.doc('admin_predictions/published').get());
    await assertFails(db.doc('admin_predictions/new').set(validPrediction()));
    await assertFails(db.doc('admin_predictions/published').delete());
  });

  test('an ordinary user may read a PUBLISHED prediction', async () => {
    await seed('published', validPrediction());
    await assertSucceeds(user().doc('admin_predictions/published').get());
  });

  test('an ordinary user may NOT read an unpublished DRAFT', async () => {
    await seed('draft', validPrediction({ visibility: 'draft' }));
    await assertFails(user().doc('admin_predictions/draft').get());
  });

  test('a published-only LIST query is allowed; an unbounded list is not', async () => {
    await seed('published', validPrediction());
    await seed('draft', validPrediction({ visibility: 'draft' }));
    const db = user();
    await assertSucceeds(
      db.collection('admin_predictions').where('visibility', '==', 'published').get(),
    );
    // Without the visibility constraint the query cannot be proven safe.
    await assertFails(db.collection('admin_predictions').get());
  });

  /* -------------------------------------------------- writes */

  test('an ordinary user cannot create, update or delete', async () => {
    await seed('published', validPrediction());
    const db = user();
    await assertFails(db.doc('admin_predictions/new').set(validPrediction({ createdBy: 'user_1' })));
    await assertFails(db.doc('admin_predictions/published').update({ status: 'won' }));
    await assertFails(db.doc('admin_predictions/published').delete());
  });

  test('a non-admin write cannot be smuggled through a batch', async () => {
    await seed('published', validPrediction());
    const db = user();
    const batch = db.batch();
    batch.set(db.doc('users/user_1'), { tokens: 1 });
    batch.update(db.doc('admin_predictions/published'), { status: 'won' });
    await assertFails(batch.commit());
  });

  test('an administrator can create a prediction they own', async () => {
    await assertSucceeds(
      adminDb('admin_1').doc('admin_predictions/new').set(validPrediction({ createdBy: 'admin_1' })),
    );
  });

  test('an administrator cannot create a prediction owned by someone else', async () => {
    await assertFails(
      adminDb('admin_1').doc('admin_predictions/new').set(validPrediction({ createdBy: 'someone_else' })),
    );
    // The creator uid must be the authenticated administrator, not merely an admin.
    await assertFails(
      adminDb('admin_2').doc('admin_predictions/new').set(validPrediction({ createdBy: 'admin_1' })),
    );
  });

  test('an administrator can read drafts, settle and delete', async () => {
    await seed('draft', validPrediction({ visibility: 'draft' }));
    const db = adminDb('admin_1');
    await assertSucceeds(db.doc('admin_predictions/draft').get());
    await assertSucceeds(db.doc('admin_predictions/draft').update({
      status: 'won',
      updatedAt: new Date(),
      settledBy: 'admin_1',
      settledAt: new Date(),
    }));
    await assertSucceeds(db.doc('admin_predictions/draft').delete());
  });

  test('ownership is immutable on update', async () => {
    await seed('published', validPrediction({ createdBy: 'admin_1' }));
    await assertFails(
      adminDb('admin_2').doc('admin_predictions/published').update({
        createdBy: 'admin_2',
        updatedAt: new Date(),
      }),
    );
  });

  test('a malformed document is refused even for an administrator', async () => {
    const db = adminDb('admin_1');
    await assertFails(db.doc('admin_predictions/bad_conf').set(validPrediction({ confidence: 150 })));
    await assertFails(db.doc('admin_predictions/bad_status').set(validPrediction({ status: 'maybe' })));
    await assertFails(db.doc('admin_predictions/bad_sport').set(validPrediction({ sport: 'Cricket' })));
    await assertFails(db.doc('admin_predictions/bad_vis').set(validPrediction({ visibility: 'hidden' })));
    // A date stored as text is refused (dates must be Firestore timestamps).
    await assertFails(db.doc('admin_predictions/bad_date').set(validPrediction({ matchDate: '2026-01-01' })));
  });
});
