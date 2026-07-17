const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const { JWT_SECRET } = require('../utils/secrets');
const { issueOtp, consumeOtp, discardOtp } = require('../utils/otp');

const router = express.Router();

/**
 * The one shape a phone number is stored and compared in.
 *
 * Routes used to disagree — send-otp trimmed, register did not — so the same
 * human could end up as two accounts, or fail to match their own OTP. Returns
 * null for anything that is not a plausible Indian mobile number.
 */
const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  // Tolerate a +91 / 0 prefix; the stored form is always the bare 10 digits.
  const local = digits.replace(/^(?:91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(local) ? local : null;
};

// POST /api/auth/register and /login are gone.
//
// They were a second way in that OTP did not guard: /register accepted any
// number without ever proving it belonged to the caller, so an attacker could
// claim a stranger's number with a password of their choosing. The real owner
// would later sign in by OTP — onto that same account — leaving the attacker
// with lasting password access to it. Nothing in the app used these routes;
// OTP is the only way a customer session is created.
const retired = (req, res) => res.status(410).json({ message: 'Please sign in with your phone number.' });
router.post('/register', retired);
router.post('/login', retired);

// POST /api/auth/vendor-login
router.post('/vendor-login', async (req, res) => {
  try {
    const { restaurantId, passkey } = req.body;
    if (!restaurantId || !passkey) return res.status(400).json({ message: 'Missing restaurantId or passkey' });

    const Restaurant = require('../models/Restaurant');
    const restaurant = await Restaurant.findById(restaurantId).select('+vendorPasskey');
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    // If no passkey is set for the restaurant, deny
    if (!restaurant.vendorPasskey) return res.status(403).json({ message: 'Vendor login not enabled for this outlet' });

    const match = await bcrypt.compare(passkey, restaurant.vendorPasskey);
    if (!match) return res.status(401).json({ message: 'Invalid passkey' });

    // Issue a token scoped to vendor role and restaurantId
    const token = jwt.sign({ role: 'vendor', restaurantId: restaurant._id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, vendor: { restaurantId: restaurant._id, name: restaurant.name, posEnabled: !!restaurant.posEnabled } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/admin-login
router.post('/admin-login', async (req, res) => {
  try {
    const { passkey } = req.body;
    if (!passkey) return res.status(400).json({ message: 'Missing passkey' });

    const hash = process.env.ADMIN_PASSKEY_HASH;
    if (!hash) return res.status(503).json({ message: 'Admin login is not configured' });

    const match = await bcrypt.compare(String(passkey), hash);
    if (!match) return res.status(401).json({ message: 'Invalid passkey' });

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, admin: { role: 'admin' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/me - validate token and optionally refresh
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'No token provided' });

    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    // Verify token
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Token expired' });
      }
      return res.status(401).json({ message: 'Invalid token' });
    }

    // Admin sessions carry no database record — the role on the token is the
    // whole identity.
    if (payload.role === 'admin') {
      return res.json({ admin: { role: 'admin' }, token: null });
    }

    // If token belongs to a vendor session, return vendor info
    if (payload.role === 'vendor' && payload.restaurantId) {
      const Restaurant = require('../models/Restaurant');
      const restaurant = await Restaurant.findById(payload.restaurantId).select('-vendorPasskey');
      if (!restaurant) return res.status(404).json({ message: 'Vendor not found' });

      // Check remaining token time and refresh if close to expiry
      const decoded = jwt.decode(token);
      const now = Math.floor(Date.now() / 1000);
      const timeLeft = (decoded && decoded.exp) ? decoded.exp - now : 0;
      const REFRESH_THRESHOLD = 60 * 60 * 24; // 1 day in seconds
      let newToken = null;
      if (timeLeft > 0 && timeLeft < REFRESH_THRESHOLD) {
        newToken = jwt.sign({ role: 'vendor', restaurantId: restaurant._id }, JWT_SECRET, { expiresIn: '7d' });
      }

      return res.json({ vendor: { restaurantId: restaurant._id, name: restaurant.name, posEnabled: !!restaurant.posEnabled }, token: newToken });
    }

    // Otherwise assume a regular user token
    const user = await User.findById(payload.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Check remaining token time and refresh if close to expiry
    const decoded = jwt.decode(token);
    const now = Math.floor(Date.now() / 1000);
    const timeLeft = (decoded && decoded.exp) ? decoded.exp - now : 0;
    const REFRESH_THRESHOLD = 60 * 60 * 24; // 1 day in seconds
    let newToken = null;
    if (timeLeft > 0 && timeLeft < REFRESH_THRESHOLD) {
      newToken = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    }

    res.json({ user, token: newToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/send-otp
//
// Rate limited in two dimensions (see otpSendLimiter): per number, because each
// send costs real money and lands on someone's phone; and per IP, so one host
// cannot cycle through numbers.
router.post('/send-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });
    }

    const issued = await issueOtp(phone);
    if (!issued.ok) {
      // Still inside the cooldown. `retryAfter` drives the countdown in the app.
      return res.status(429).json({
        message: `Please wait ${issued.retryAfter}s before requesting another code.`,
        retryAfter: issued.retryAfter,
      });
    }

    try {
      const response = await axios.post(
        'https://www.fast2sms.com/dev/bulkV2',
        {
          message: `Your MR BITES login OTP is ${issued.otp}`,
          route: 'q',
          numbers: phone,
        },
        {
          headers: {
            authorization: process.env.FAST2SMS_API_KEY,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      if (response.data.return === false) {
        console.error('Fast2SMS Error:', response.data);
        // Our provider failed, not the user — drop the code so they are not
        // held behind a cooldown for a message that never arrived.
        await discardOtp(phone);
        return res.status(502).json({ message: 'Could not send the OTP right now. Please try again.' });
      }
    } catch (smsErr) {
      await discardOtp(phone);
      console.error('Send OTP failed', smsErr?.message || smsErr);
      return res.status(502).json({ message: 'Could not send the OTP right now. Please try again.' });
    }

    // The app counts down from this before re-enabling "Resend".
    res.json({ message: 'OTP sent successfully', retryAfter: issued.retryAfter });
  } catch (err) {
    console.error('Send OTP failed', err?.message || err);
    res.status(500).json({ message: 'Could not send the OTP right now. Please try again.' });
  }
});

// POST /api/auth/verify-otp — the only way to obtain a customer session.
router.post('/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const { otp, name } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });

    const check = await consumeOtp(phone, otp);
    if (!check.ok) return res.status(400).json({ message: check.message });

    let user = await User.findOne({ phone });
    if (!user) {
      // Sessions are proven by OTP, so the password column is vestigial for
      // customers. It stays non-null with an unguessable value rather than being
      // made optional, so no account can ever be signed into with a blank one.
      const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      // No name when someone signs in by OTP without signing up. The app spots
      // the blank and asks them, instead of labelling them "User" forever.
      user = new User({ name: (name || '').trim(), phone, password: randomPassword });
      await user.save();
    } else if (name?.trim() && !user.name) {
      // They signed up later with a name — fill in the blank.
      user.name = name.trim();
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error('Verify OTP failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
