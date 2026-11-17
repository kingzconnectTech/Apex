#!/usr/bin/env node
/**
 * scripts/set-admin-claim.js
 *
 * Grant (or revoke) the `admin: true` Firebase Authentication CUSTOM CLAIM.
 *
 * WHY THIS EXISTS
 *   Administrator access to the Admin Predictions system is decided by a single
 *   custom claim on the user's Firebase token, and it is enforced by the
 *   Firestore security rules (firestore.rules) and by the AdminRoute guard in
 *   the app. A custom claim can only be written with the Firebase ADMIN SDK, so
 *   no user can ever grant it to themselves from the client. This script is the
 *   one and only way to become an administrator.
 *
 * USAGE
 *   node scripts/set-admin-claim.js --email=ops@example.com
 *   node scripts/set-admin-claim.js --uid=ABC123
 *   node scripts/set-admin-claim.js --email=ops@example.com --revoke
 *
 *   The target user must already have signed in at least once (the account must
 *   exist). The claim takes effect on the user's next token refresh; the app
 *   forces a refresh when it re-checks, so a fresh sign-in is not required.
 *
 * CREDENTIALS
 *   The same Firebase Admin credentials the server uses:
 *     - FIREBASE_SERVICE_ACCOUNT_JSON (a JSON string), or
 *     - ./serviceAccountKey.json beside the backend.
 *   The private key is NEVER printed or logged.
 */

const path = require('path');
const admin = require('firebase-admin');

function parseArgs(argv) {
  const args = { uid: null, email: null, revoke: false };
  argv.forEach(arg => {
    if (arg.startsWith('--uid=')) args.uid = arg.slice('--uid='.length).trim();
    else if (arg.startsWith('--email=')) args.email = arg.slice('--email='.length).trim();
    else if (arg === '--revoke') args.revoke = true;
  });
  return args;
}

function initAdmin() {
  if (admin.apps && admin.apps.length) return admin;
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    // Resolved relative to the backend directory (the parent of scripts/).
    serviceAccount = require(path.join(__dirname, '..', 'serviceAccountKey.json'));
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

async function resolveUid(auth, { uid, email }) {
  if (uid) return uid;
  if (email) return (await auth.getUserByEmail(email)).uid;
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.uid && !args.email) {
    console.error('Usage: node scripts/set-admin-claim.js --uid=<uid> | --email=<email> [--revoke]');
    process.exit(1);
  }

  initAdmin();
  const auth = admin.auth();

  const uid = await resolveUid(auth, args);
  const user = await auth.getUser(uid);

  // Preserve any existing claims; only the `admin` key is changed here.
  const existing = user.customClaims || {};
  const nextClaims = { ...existing };

  if (args.revoke) {
    delete nextClaims.admin;
  } else {
    nextClaims.admin = true;
  }

  await auth.setCustomUserClaims(uid, nextClaims);
  // Force a token refresh so the claim applies to the next request without a
  // full sign-out/sign-in.
  await auth.revokeRefreshTokens(uid);

  console.log(JSON.stringify({
    ok: true,
    uid,
    email: user.email || null,
    admin: nextClaims.admin === true,
    message: args.revoke
      ? 'Administrator access revoked. The user must sign in again for the change to apply.'
      : 'Administrator access granted. The user must sign in again for the change to apply.',
  }, null, 2));
}

main().catch(err => {
  console.error('Failed to set the admin claim:', err && err.message ? err.message : err);
  process.exit(1);
});
