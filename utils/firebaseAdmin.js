// Lazy, singleton Firebase Admin init — mirrors how the payment gateway utils
// in this codebase pick up their credentials from env vars rather than a
// committed file. Nothing here runs until a push is actually sent, so a
// misconfigured/missing credential never blocks server startup.
//
// firebase-admin v13+ is modular: credentials come from `firebase-admin/app`
// (`initializeApp`/`cert`) and messaging from `firebase-admin/messaging`. The
// old namespaced form (`admin.credential.cert`, `admin.messaging()`) no longer
// exists on the root export.

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging: getAdminMessaging } = require('firebase-admin/messaging');

const APP_NAME = 'mrbites-push';

let app = null;

function getApp() {
  if (app) return app;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Stored in .env with literal \n sequences (a real newline would break the
  // single-line env format), unescaped here before use.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin is not configured — set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.');
  }

  // Named app so this can't collide with any default app another dependency
  // might initialise, and so a hot-reload doesn't throw "already exists".
  const existing = getApps().find((a) => a.name === APP_NAME);
  app = existing || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }, APP_NAME);
  return app;
}

function getMessaging() {
  return getAdminMessaging(getApp());
}

// True once the required env vars are present, without throwing — lets
// callers skip push-sending quietly (e.g. in dev) instead of erroring.
function isConfigured() {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

module.exports = { getMessaging, isConfigured };
