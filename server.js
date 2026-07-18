// backend/server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables from .env — before anything reads them.
dotenv.config();

// Validates JWT_SECRET and aborts the boot if it is missing or a placeholder.
// Required this early so no router can be loaded against a bad secret.
require('./utils/secrets');

const rateLimit = require('express-rate-limit');
// Normalises an IPv6 address to its /64 prefix. A bare req.ip would let an IPv6
// client hop addresses within its own allocation and sidestep the limit.
const { ipKeyGenerator } = require('express-rate-limit');
const { verifyToken, ownsOutlet } = require('./middleware/auth');

// Import routers
const ordersRouter = require('./routes/orders');
const authRouter = require('./routes/auth');
const restaurantsRouter = require('./routes/restaurants');
const usersRouter = require('./routes/users');
const paymentRouter = require('./routes/payment');
const uploadRouter = require('./routes/upload');
const financeRouter = require('./routes/finance');
const settingsRouter = require('./routes/settings');

const app = express();

/* ------------------ SECURITY HEADERS ------------------ */
try {
  const helmet = require('helmet');
  app.use(helmet());
} catch {
  // helmet not installed; run: npm install helmet
}

/* ------------------ CORS SETUP ------------------ */
//
// The native app sends no Origin header, so it is unaffected by CORS entirely —
// the browser surfaces (landing, vendor, admin) are what this is for. In
// production those are a known, short list; allowing '*' there bought nothing
// and let any site script the API against a logged-in browser session.
//
// Set CORS_ORIGINS to a comma-separated list in production. Unset, we assume
// development and allow everything, which keeps Expo/localhost working.
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = configuredOrigins.length
  ? {
      origin: (origin, cb) => {
        // No origin: a native app, curl, or a server-to-server call.
        if (!origin) return cb(null, true);
        if (configuredOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }
  : {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    };

if (!configuredOrigins.length && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  CORS_ORIGINS is unset in production — the API is open to every origin.');
}

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

/* ------------------ MIDDLEWARE ------------------ */
app.use(express.json({ limit: '100kb' }));

// Behind a proxy (Render, nginx) the client IP arrives in X-Forwarded-For.
// Without this every request looks like it comes from the proxy and the rate
// limiters below would throttle all users as one.
app.set('trust proxy', 1);

/* ------------------ RATE LIMITS ------------------ */
//
// Nothing was limited before. The costly cases:
//   send-otp   — every call sends a real SMS we pay for, to someone's phone.
//   verify-otp — the brute-force surface; the per-code attempt ceiling in
//                utils/otp caps guesses, this caps how fast codes are cycled.
//
// KEYING MATTERS MORE THAN THE NUMBERS HERE.
//
// MR-Bites serves one campus. Essentially every student is behind the same
// NAT, so to this server the whole university looks like a single IP address.
// An IP-keyed limit does not throttle an attacker — it throttles the campus:
// at 20/15min the twenty-first student to sign up in a lunch rush is simply
// told to go away, and the outage looks like the app being broken.
//
// So the limits that must be tight are keyed by the thing being protected —
// the phone number receiving the SMS — and the IP limits are set wide enough to
// be invisible to real traffic while still stopping a runaway script.
const limiter = (windowMs, max, message, keyGenerator) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { message },
  });

// Keyed by phone: one number cannot be flooded with texts no matter how many
// addresses ask. This is the limit that actually protects the SMS bill, and it
// is unaffected by everyone sharing an IP.
//
// The 15-second cooldown in utils/otp is what a real person meets; this is the
// ceiling behind it. Eight in a quarter of an hour is far more than anyone
// legitimately needs — someone who mistyped their number and retried a few
// times never sees it — while capping a scripted number at 32 texts an hour.
//
// Every throttled answer carries `retryAfter` in seconds, because the sign-in
// screen counts down from it. A 429 with no number to show would leave the
// button disabled with nothing to tell the student.
const otpSendPhoneLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    return phone ? `phone:${phone}` : ipKeyGenerator(req, res);
  },
  handler: (req, res) => {
    const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000));
    res.status(429).json({
      message: 'Too many codes requested for this number. Please try again later.',
      retryAfter,
    });
  },
});

// Campus-wide backstop. Sized for a whole university behind one address — a
// lunch rush of a few hundred sign-ins passes untouched; a script hammering
// thousands of numbers does not.
const otpSendIpLimiter = limiter(15 * 60 * 1000, 300, 'Too many requests. Please try again shortly.');

// Keyed by phone again: a student mistyping their code must never be able to
// lock out the rest of the campus. Brute force is already bounded by the
// five-attempts-per-code ceiling in utils/otp.
const otpVerifyLimiter = limiter(
  15 * 60 * 1000,
  15,
  'Too many attempts for this number. Please request a new code.',
  (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    return phone ? `verify:${phone}` : ipKeyGenerator(req, res);
  }
);

// Staff logins are low volume, but vendors sit on the same campus network, so
// this is still generous enough not to catch them collectively.
const authLimiter = limiter(15 * 60 * 1000, 50, 'Too many attempts. Please try again shortly.');

app.use('/api/auth/send-otp', otpSendIpLimiter, otpSendPhoneLimiter);
app.use('/api/auth/verify-otp', otpVerifyLimiter);
app.use('/api/auth/vendor-login', authLimiter);
app.use('/api/auth/admin-login', authLimiter);
// Payments are limited per signed-in user, inside the route — see routes/payment.js.
// An IP limit there would have failed the whole lunch rush at once.

/* ------------------ BASIC TEST ROUTES ------------------ */

// For quick "is backend alive?" test in browser
app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

// Health check route for testing from phone: /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

/* ------------------ API ROUTES ------------------ */

app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);
app.use('/api/restaurants', restaurantsRouter);
app.use('/api/users', usersRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/finance', financeRouter);
app.use('/api/settings', settingsRouter);

/* ------------------ ERRORS ------------------ */

// 404 for anything unmatched, as JSON — the app parses every response as JSON,
// and Express's HTML default breaks it.
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// The catch-all. Routes handle their own errors; this exists so an unexpected
// throw returns something sane instead of Express's stack-trace page, which
// leaks file paths and library versions.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'That request is too large.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'That request could not be read.' });
  }

  // Body-parser and friends classify their own failures. Honour that rather
  // than calling a client's malformed request a server fault — a 500 here would
  // page someone at 3am for a bad curl, and tells the caller nothing useful.
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ message: err.expose ? err.message : 'Bad request' });
  }

  console.error('Unhandled error', { path: req.path, method: req.method, err });
  res.status(500).json({ message: 'Something went wrong. Please try again.' });
});

/* ------------------ HTTP SERVER + SOCKET.IO ------------------ */

const PORT = process.env.PORT || 4040; // Make sure this matches your API_BASE_URL
const server = http.createServer(app);

const io = new Server(server, {
  cors: configuredOrigins.length
    ? { origin: configuredOrigins, methods: ['GET', 'POST'] }
    : { origin: '*', methods: ['GET', 'POST'] },
});

// Identify the connection, if it offers a token.
//
// Connecting stays open, because customers legitimately listen for public
// broadcasts (an outlet opening, a menu changing) without being signed in. What
// changes is that a *room* now has to be earned — see joinRestaurant.
io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.split(' ')[1];
  socket.user = verifyToken(token); // null when absent or invalid
  next();
});

io.on('connection', (socket) => {
  /**
   * An outlet's room carries live order.created events — customer names, phone
   * numbers, items, totals. This used to join anyone who asked, for any outlet,
   * which meant any user of the app could silently subscribe to a competitor's
   * feed and harvest their customers' personal details.
   *
   * Now it is exactly the check the REST routes use: you must hold a vendor
   * token for that outlet, or be an admin.
   */
  socket.on('joinRestaurant', (restaurantId, ack) => {
    if (!restaurantId) return;

    if (!socket.user || !ownsOutlet(socket.user, restaurantId)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Not authorised for this outlet' });
      return;
    }

    socket.join(`restaurant:${restaurantId}`);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {});
});

// Make Socket.IO available in routes (req.app.get('io'))
app.set('io', io);

/* ------------------ DATABASE SETUP ------------------ */

const MONGO_URI = process.env.MONGO_URI;

// Connect to MongoDB, then start the server
mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    // Log the exact database this deployment is bound to. If send and verify
    // ever disagreed on the code, the first thing to rule out is that they are
    // talking to different databases — this makes the answer visible at boot.
    console.log(`✅ MongoDB connected — db="${mongoose.connection.name}" host=${mongoose.connection.host}`);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('⚠️ MongoDB connection failed, exiting:', err.message || err);
    process.exit(1);
  });

module.exports = app;
