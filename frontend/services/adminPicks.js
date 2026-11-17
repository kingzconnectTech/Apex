/**
 * Admin Predictions data access.
 *
 * The ONE place the Admin Predictions system talks to Firestore. It only ever
 * touches the dedicated `admin_predictions` collection — nothing here reads or
 * writes any AI-engine data — and every write carries the fields the security
 * rules require (status, visibility, ownership, timestamps).
 *
 * Reads use Firestore real-time listeners so a user's Admin Picks screen updates
 * the moment an administrator uploads or settles a pick, and an administrator's
 * dashboard updates the moment anything changes.
 *
 * Authorization is NOT decided here. Firestore security rules enforce it
 * server-side from the `admin: true` custom claim; these helpers simply reflect
 * that decision in the UI (see context/AdminContext and components/AdminRoute).
 */

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import {
  COLLECTION,
  VISIBILITY,
  STATUS,
  STATUSES,
  buildCreatePayload,
  buildUpdatePayload,
} from '../utils/adminPicksView';

/** Map a Firestore document into a plain, screen-friendly object. */
function mapDoc(doc) {
  const data = doc.data() || {};
  return { id: doc.id, ...data };
}

/** Convert a JS Date (or Date-like) into a Firestore Timestamp, or null. */
function toTimestamp(value) {
  if (value == null) return null;
  if (typeof value.toDate === 'function') return value; // already a Timestamp
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return firestore.Timestamp.fromDate(d);
}

/**
 * True when the signed-in user carries the `admin: true` custom claim.
 *
 * `forceRefresh` asks Firebase for a fresh ID token, so a claim granted by the
 * server takes effect without a full sign-out. Returns false on any error (a
 * missing network must never advertise admin access).
 */
export async function isAdminUser(user = auth().currentUser, forceRefresh = false) {
  if (!user) return false;
  try {
    const result = await user.getIdTokenResult(forceRefresh);
    return Boolean(result && result.claims && result.claims.admin === true);
  } catch (error) {
    console.warn('[adminPicks] admin claim check failed:', error.message);
    return false;
  }
}

/** The admin's uid, or null. */
function currentUid() {
  const user = auth().currentUser;
  return user ? user.uid : null;
}

/**
 * Real-time subscription to PUBLISHED predictions only (the user-facing screen).
 * Ordered newest kick-off first. Returns the unsubscribe function.
 */
export function subscribePublishedPicks(onData, onError) {
  return firestore()
    .collection(COLLECTION)
    .where('visibility', '==', VISIBILITY.PUBLISHED)
    .onSnapshot(
      (snapshot) => {
        const picks = [];
        snapshot.forEach(doc => picks.push(mapDoc(doc)));
        onData(picks);
      },
      (error) => {
        console.warn('[adminPicks] published subscription error:', error.message);
        if (onError) onError(error);
      },
    );
}

/** Real-time subscription to EVERY prediction, including drafts (admin only). */
export function subscribeAllPicks(onData, onError) {
  return firestore()
    .collection(COLLECTION)
    .orderBy('createdAt', 'desc')
    .onSnapshot(
      (snapshot) => {
        const picks = [];
        snapshot.forEach(doc => picks.push(mapDoc(doc)));
        onData(picks);
      },
      (error) => {
        console.warn('[adminPicks] admin subscription error:', error.message);
        if (onError) onError(error);
      },
    );
}

/**
 * Create a prediction. `visibility` decides whether it is stored as a draft or
 * published immediately. New predictions always start `pending`.
 *
 * @returns {Promise<{ok:boolean, id?:string, errors?:Object, message?:string}>}
 */
export async function createPick(form, { visibility = VISIBILITY.DRAFT } = {}) {
  const uid = currentUid();
  if (!uid) return { ok: false, message: 'You must be signed in.' };

  const built = buildCreatePayload(form, { visibility });
  if (!built.ok) return { ok: false, errors: built.errors };

  const matchDate = toTimestamp(built.payload.matchDate);
  if (!matchDate) return { ok: false, errors: { matchDate: 'A valid match date and time is required.' } };

  try {
    const ref = await firestore().collection(COLLECTION).add({
      ...built.payload,
      matchDate,
      status: STATUS.PENDING,
      createdBy: uid,
      createdAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
      settledBy: null,
      settledAt: null,
    });
    return { ok: true, id: ref.id };
  } catch (error) {
    console.warn('[adminPicks] create failed:', error.message);
    return { ok: false, message: error.message };
  }
}

/** Edit an existing prediction's content. Ownership and status are untouched. */
export async function updatePick(id, form) {
  const built = buildUpdatePayload(form);
  if (!built.ok) return { ok: false, errors: built.errors };

  const matchDate = toTimestamp(built.payload.matchDate);
  if (!matchDate) return { ok: false, errors: { matchDate: 'A valid match date and time is required.' } };

  try {
    await firestore().collection(COLLECTION).doc(id).update({
      ...built.payload,
      matchDate,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, id };
  } catch (error) {
    console.warn('[adminPicks] update failed:', error.message);
    return { ok: false, message: error.message };
  }
}

/** Delete a prediction. */
export async function deletePick(id) {
  try {
    await firestore().collection(COLLECTION).doc(id).delete();
    return { ok: true, id };
  } catch (error) {
    console.warn('[adminPicks] delete failed:', error.message);
    return { ok: false, message: error.message };
  }
}

/** Publish a draft, or return a published pick to draft. */
export async function setVisibility(id, visibility) {
  try {
    await firestore().collection(COLLECTION).doc(id).update({
      visibility,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, id };
  } catch (error) {
    console.warn('[adminPicks] visibility change failed:', error.message);
    return { ok: false, message: error.message };
  }
}

export const publishPick = id => setVisibility(id, VISIBILITY.PUBLISHED);
export const unpublishPick = id => setVisibility(id, VISIBILITY.DRAFT);

/**
 * Settle a prediction: set its status and record WHO settled it and WHEN.
 * Re-opening (status `pending`) clears the settlement record.
 */
export async function settlePick(id, status) {
  const uid = currentUid();
  if (!uid) return { ok: false, message: 'You must be signed in.' };
  const next = status == null ? '' : String(status).toLowerCase();
  if (!STATUSES.includes(next)) return { ok: false, message: 'Unknown status.' };

  const reopening = next === STATUS.PENDING;
  try {
    await firestore().collection(COLLECTION).doc(id).update({
      status: next,
      updatedAt: firestore.FieldValue.serverTimestamp(),
      settledBy: reopening ? null : uid,
      settledAt: reopening ? null : firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, id };
  } catch (error) {
    console.warn('[adminPicks] settle failed:', error.message);
    return { ok: false, message: error.message };
  }
}

export { COLLECTION };
