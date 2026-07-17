const express = require('express');
const rateLimit = require('express-rate-limit');

const User = require('../models/User');
const OrderDraft = require('../models/OrderDraft');
const Settings = require('../models/Settings');
const { authenticate } = require('../middleware/auth');
const { priceCart } = require('../utils/priceCart');
const { razorpay, isConfigured, key_id } = require('../utils/razorpay');

const router = express.Router();

// Keyed by user, and mounted *after* authenticate so req.user exists.
//
// The whole campus shares one NAT'd address, so an IP-keyed limit here would
// have meant the thirtieth order of a lunch rush failing for everyone —
// throttling the customers instead of an abuser. A person opening 20 payment
// attempts in 10 minutes is already well beyond normal use.
const perUserPaymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id}`,
  message: { message: 'Too many payment attempts. Please wait a moment and try again.' },
});

// How long a quote stands. Long enough to finish paying, short enough that a
// stale price can't be redeemed much later.
const DRAFT_TTL_MS = 30 * 60 * 1000;

/**
 * POST /api/payment/create-order
 *
 * Quotes a cart and opens a Razorpay order for it.
 *
 * The client sends what it wants — item ids, quantities, chosen option names —
 * and nothing about money. The server prices it from the database, validates it
 * (platform open, outlets open, items in stock, modifier rules satisfied), and
 * charges *its own* total. The priced cart is stored against the Razorpay order
 * id so that confirmation can build the orders from it rather than from
 * whatever the client sends back.
 *
 * This is also the only validation gate the checkout needs: an invalid cart is
 * rejected here, before the payment sheet ever opens, so the customer is never
 * charged for an order that cannot be placed.
 */
router.post('/create-order', authenticate, perUserPaymentLimiter, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: 'Payments are not configured right now.' });
    }

    // No real payment may be opened in a demo context. The client routes to the
    // demo order flow instead, but this refusal is the actual guarantee — a
    // tampered client still cannot reach Razorpay when demo mode is on or the
    // caller is the review account.
    const [settings, payer] = await Promise.all([
      Settings.get(),
      User.findById(req.user.id).select('isDemo').lean(),
    ]);
    if (settings.demoMode || payer?.isDemo) {
      return res.status(409).json({ reason: 'demo_mode', message: 'Demo mode is on — no real payment is taken.' });
    }

    const { items, pickupType, notes } = req.body || {};

    const priced = await priceCart(items);
    if (!priced.ok) {
      // 409: the cart is at odds with the live menu — the app shows `message`
      // and refreshes. Deliberately not a 400; nothing is malformed, the world
      // simply moved on.
      return res.status(409).json({ reason: priced.reason, message: priced.message });
    }

    const user = await User.findById(req.user.id).select('name phone').lean();
    if (!user) return res.status(401).json({ message: 'Please sign in again.' });

    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(priced.total * 100), // paise, from the server's total
      currency: 'INR',
      receipt: `mrb_${Date.now()}_${String(user._id).slice(-6)}`,
      payment_capture: 1,
      notes: { userId: String(user._id) },
    });

    await OrderDraft.create({
      razorpayOrderId: rzpOrder.id,
      userId: user._id,
      // A student who never set a name still needs something on the ticket the
      // counter reads out, so it falls back to "User" rather than a blank.
      customer: { name: user.name?.trim() || 'User', phone: user.phone },
      groups: priced.groups,
      total: priced.total,
      pickupType: pickupType === 'PICK_UP' ? 'PICK_UP' : 'DINE_IN',
      notes,
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
    });

    res.json({
      order: { id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency },
      key: key_id,
      // Echoed so the app can show the authoritative total before paying, and
      // spot a drift from what it had on screen.
      total: priced.total,
    });
  } catch (err) {
    console.error('Create payment order failed', err);
    res.status(500).json({ message: 'Could not start the payment. Please try again.' });
  }
});

module.exports = router;
