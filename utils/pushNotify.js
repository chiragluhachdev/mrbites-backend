// Sends FCM pushes and prunes dead tokens as a side effect of sending — no
// separate cleanup job needed. Every function here is best-effort: a push
// failure never throws back into the caller (order creation/status-change must
// never fail because a notification didn't go out), it just logs and returns.

const User = require('../models/User');
const { getMessaging, isConfigured } = require('./firebaseAdmin');

// FCM's multicast send caps at 500 tokens per call.
const CHUNK_SIZE = 500;
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// FCM data payloads are string-only — no numbers/booleans/nested objects.
const stringifyData = (data) =>
  Object.fromEntries(Object.entries(data || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));

/**
 * Sends one message to a batch of tokens, then removes from every user's
 * pushTokens any token FCM reports as no-longer-registered — the actual
 * "prune invalid tokens automatically" behaviour, driven off the real
 * per-token delivery result rather than a guess.
 */
async function sendToTokens(tokens, { title, body, image, data }) {
  const unique = [...new Set((tokens || []).filter(Boolean))];
  if (!unique.length) return { successCount: 0, failureCount: 0 };
  // A missing credential is a deployment fault, not "delivered to zero people" —
  // throwing makes an admin broadcast record it as Failed rather than quietly
  // reporting success. Order pushes swallow it (they're fire-and-forget), so
  // this can't break checkout either way.
  if (!isConfigured()) {
    throw new Error('Firebase Admin is not configured — set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.');
  }

  const messaging = getMessaging();
  let successCount = 0;
  let failureCount = 0;
  const dead = [];

  for (const batch of chunk(unique, CHUNK_SIZE)) {
    try {
      const res = await messaging.sendEachForMulticast({
        notification: { title, body, ...(image ? { imageUrl: image } : {}) },
        data: stringifyData(data),
        tokens: batch,
      });
      successCount += res.successCount;
      failureCount += res.failureCount;
      res.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          dead.push(batch[i]);
        }
      });
    } catch (err) {
      console.error('[push] batch send failed', err.message);
      failureCount += batch.length;
    }
  }

  if (dead.length) {
    try {
      await User.updateMany({}, { $pull: { pushTokens: { token: { $in: dead } } } });
    } catch (err) {
      console.error('[push] failed to prune dead tokens', err.message);
    }
  }

  return { successCount, failureCount };
}

const tokensOf = (user) => (user?.pushTokens || []).map((t) => t.token);

/** Push to one user's every registered device, by their account id. */
async function notifyUser(userId, payload) {
  if (!userId) return { successCount: 0, failureCount: 0 };
  const user = await User.findById(userId).select('pushTokens');
  return sendToTokens(tokensOf(user), payload);
}

/** Push to one user's every registered device, by phone — orders are keyed on
 * customer.phone rather than a userId reference, so this is the lookup the
 * order-lifecycle hooks actually use. */
async function notifyByPhone(phone, payload) {
  if (!phone) return { successCount: 0, failureCount: 0 };
  const user = await User.findOne({ phone }).select('pushTokens');
  return sendToTokens(tokensOf(user), payload);
}

/** Push to a specific set of users (the admin "selected users" audience). */
async function notifyUsers(userIds, payload) {
  if (!userIds?.length) return { successCount: 0, failureCount: 0 };
  const users = await User.find({ _id: { $in: userIds } }).select('pushTokens');
  return sendToTokens(users.flatMap(tokensOf), payload);
}

/** Push to every user with at least one registered device (the admin "all" audience). */
async function notifyAll(payload) {
  const users = await User.find({ 'pushTokens.0': { $exists: true } }).select('pushTokens');
  return sendToTokens(users.flatMap(tokensOf), payload);
}

module.exports = { notifyUser, notifyByPhone, notifyUsers, notifyAll };
