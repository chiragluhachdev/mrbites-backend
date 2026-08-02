const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { consumeOtp } = require('../utils/otp');

const router = express.Router();

const PHONE_RE = /^[6-9]\d{9}$/;

// PATCH /api/users/me — a signed-in user edits their own profile.
// Scoped to the token's own id, so nobody can rename anyone else.
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Please enter your name' });
    }
    if (name.trim().length > 60) {
      return res.status(400).json({ message: 'That name is too long' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { name: name.trim() },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Failed to update profile', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/users/me/phone — change the account's phone number.
// The phone is the login identity, so the new number must be OTP-verified. The
// client sends the OTP it received on the new number (via /api/auth/send-otp).
router.patch('/me/phone', authenticate, async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const newPhone = (phone || '').trim();

    if (!PHONE_RE.test(newPhone)) {
      return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number' });
    }
    if (!otp) return res.status(400).json({ message: 'Enter the OTP sent to the new number' });

    // Prove the caller controls the new number. Goes through the shared verifier
    // so the attempt ceiling applies here exactly as it does at sign-in —
    // otherwise this route would be an unguarded way to brute-force a number.
    const check = await consumeOtp(newPhone, otp);
    if (!check.ok) return res.status(400).json({ message: check.message });

    // Never let two accounts share a number.
    const clash = await User.findOne({ phone: newPhone, _id: { $ne: req.user.id } });
    if (clash) return res.status(409).json({ message: 'That number is already in use' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const oldPhone = user.phone;

    if (oldPhone !== newPhone) {
      user.phone = newPhone;
      await user.save();
      // Orders are matched by customer.phone, so carry this user's history to the
      // new number rather than orphaning it.
      await Order.updateMany({ 'customer.phone': oldPhone }, { 'customer.phone': newPhone });
    }

    const safe = user.toObject();
    delete safe.password;
    res.json({ user: safe });
  } catch (err) {
    console.error('Failed to change phone', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/users/me — permanently delete the signed-in user's account.
//
// Requires an OTP sent to the account's own number, so a stolen/borrowed phone
// with an open session can't nuke the account. Orders are deliberately LEFT in
// place: they are name/phone snapshots with no account link, and a vendor's
// sales records plus the platform's finance and settlements must survive a user
// deleting themselves. Deleting orders here would corrupt payouts.
router.delete('/me', authenticate, async (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!otp) return res.status(400).json({ message: 'Enter the OTP sent to your number' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // The code must have been sent to this account's own number. Shared verifier,
    // so the attempt ceiling covers account deletion too.
    const check = await consumeOtp(user.phone, otp);
    if (!check.ok) return res.status(400).json({ message: check.message });

    await User.deleteOne({ _id: user._id });
    // Orders are intentionally not touched — see note above.

    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('Failed to delete account', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/users/push-token — register this device for the signed-in account.
//
// The number is taken from the token, never the body. Previously the body named
// the account, unauthenticated: anyone could point a stranger's notifications at
// their own device, and the 404-vs-200 answer told them which numbers existed.
//
// One user can hold several device tokens (phone + tablet, or a reinstall that
// gets a fresh token) — this upserts by token value so registering the same
// device twice is a no-op rather than a duplicate entry, and re-registering
// just refreshes updatedAt.
router.post('/push-token', authenticate, async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string') return res.status(400).json({ message: 'Missing token' });

    await User.updateOne(
      { _id: req.user.id },
      { $pull: { pushTokens: { token } } }
    );
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $push: { pushTokens: { token, platform: platform === 'ios' ? 'ios' : 'android', updatedAt: new Date() } } },
      { new: true }
    ).select('-password -pushTokens');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Failed to register push token', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/users/push-token — drop this one device (called on logout, so a
// signed-out phone stops receiving another account's order updates once
// someone else signs in on it).
router.delete('/push-token', authenticate, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') return res.status(400).json({ message: 'Missing token' });

    await User.updateOne({ _id: req.user.id }, { $pull: { pushTokens: { token } } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to unregister push token', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users - list users (for admin). `search` (name or phone, optional)
// backs the notification composer's "selected users" picker.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const filter = {};
    const search = (req.query.search || '').trim();
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }
    // The existing (no-search) admin call reads every user — AdminUsers.js shows
    // that count as "Total", so it must stay unpaginated. A search narrows the
    // result on its own; the cap there is just a sane ceiling for a picker UI.
    let query = User.find(filter).select('-password -pushTokens').sort({ createdAt: -1 });
    if (search) query = query.limit(200);
    const users = await query;
    res.json({ users });
  } catch (err) {
    console.error('Failed to fetch users', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/me — the signed-in user's own profile.
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -pushToken');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Failed to fetch user', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/:id — admin only.
//
// This was open to the internet: any id returned that person's name, phone and
// push token. Ids are guessable enough in bulk that it amounted to publishing
// the user table. Nothing in the app called it; the admin console does.
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Failed to fetch user', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
