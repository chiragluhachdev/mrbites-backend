const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const mongoose = require('mongoose');
const axios = require('axios');
const Otp = require('../models/Otp');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ message: 'Missing fields' });

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }

    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone already registered' });

    const hash = await bcrypt.hash(password, 10);
    const user = new User({ name, phone, password: hash });
    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user._id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});


// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ message: 'Missing fields' });

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }

    const user = await User.findOne({ phone });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

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
    const token = jwt.sign({ role: 'vendor', restaurantId: restaurant._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

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

    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'secret', { expiresIn: '12h' });
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
      payload = jwt.verify(token, process.env.JWT_SECRET || 'secret');
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
        newToken = jwt.sign({ role: 'vendor', restaurantId: restaurant._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
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
      newToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    }

    res.json({ user, token: newToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Missing phone number' });

    const phoneRegex = /^[6-9]\d{9}$/;
    if (!phoneRegex.test(phone.trim())) {
      return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });
    }

    // Generate a 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete any existing OTPs for this phone to prevent brute-force
    await Otp.deleteMany({ phone });
    await Otp.create({ phone, otp });

    // Send SMS via Fast2SMS using Quick Route (q) since OTP route requires Website Verification
    const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
      message: `Your MR BITES login OTP is ${otp}`,
      route: 'q',
      numbers: phone
    }, {
      headers: {
        'authorization': process.env.FAST2SMS_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.return === false) {
       console.error('Fast2SMS Error:', response.data);
       return res.status(500).json({ message: 'Failed to send OTP' });
    }

    res.json({ message: 'OTP sent successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    if (!phone || !otp) return res.status(400).json({ message: 'Missing fields' });

    // Verify OTP
    const otpRecord = await Otp.findOne({ phone, otp });
    if (!otpRecord) return res.status(400).json({ message: 'Invalid or expired OTP' });

    // OTP is valid, delete it so it can't be reused
    await Otp.deleteOne({ _id: otpRecord._id });

    // Check if user exists
    let user = await User.findOne({ phone });
    if (!user) {
      const randomPassword = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 10);
      // No name when someone signs in by OTP without signing up. The app spots
      // the blank and asks them, instead of labelling them "User" forever.
      user = new User({ name: (name || '').trim(), phone, password: randomPassword });
      await user.save();
    } else if (name?.trim() && !user.name) {
      // They signed up later with a name — fill in the blank.
      user.name = name.trim();
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
