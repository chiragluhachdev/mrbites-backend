// Lazy, singleton Firebase Admin init — mirrors how the payment gateway utils
// in this codebase pick up their credentials from env vars rather than a
// committed file. Nothing here runs until a push is actually sent, so a
// misconfigured/missing credential never blocks server startup.

const admin = require('firebase-admin');

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

  app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  return app;
}

function getMessaging() {
  return admin.messaging(getApp());
}

// True once the required env vars are present, without throwing — lets
// callers skip push-sending quietly (e.g. in dev) instead of erroring.
function isConfigured() {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

module.exports = { getMessaging, isConfigured };
