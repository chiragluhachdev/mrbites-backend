const express = require('express');
const User = require('../models/User');
const Otp = require('../models/Otp');
const Order = require('../models/Order');
const { authenticate, requireAdmin } = require('../middleware/auth');

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

    // Prove the caller controls the new number.
    const record = await Otp.findOne({ phone: newPhone, otp: String(otp) });
    if (!record) return res.status(400).json({ message: 'Invalid or expired OTP' });

    // Never let two accounts share a number.
    const clash = await User.findOne({ phone: newPhone, _id: { $ne: req.user.id } });
    if (clash) return res.status(409).json({ message: 'That number is already in use' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const oldPhone = user.phone;
    await Otp.deleteOne({ _id: record._id });

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

    // The code must have been sent to this account's own number.
    const record = await Otp.findOne({ phone: user.phone, otp: String(otp) });
    if (!record) return res.status(400).json({ message: 'Invalid or expired OTP' });

    await Otp.deleteOne({ _id: record._id });
    await User.deleteOne({ _id: user._id });
    // Orders are intentionally not touched — see note above.

    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('Failed to delete account', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/users/push-token
// body: { phone, token }
router.post('/push-token', async (req, res) => {
  try {
    const { phone, token } = req.body;
    if (!phone || !token) return res.status(400).json({ message: 'Missing phone or token' });
    const user = await User.findOneAndUpdate({ phone }, { pushToken: token }, { new: true, upsert: false }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Failed to register push token', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users - list users (for admin)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) {
    console.error('Failed to fetch users', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/:id - single user
router.get('/:id', async (req, res) => {
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
