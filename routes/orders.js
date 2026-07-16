const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { authenticate, requireVendor, requireAdmin, ownsOutlet } = require('../middleware/auth');
const { priceOrder } = require('../utils/pricing');
const crypto = require('crypto');

const VALID_STATUSES = ['pending', 'preparing', 'ready', 'delivered', 'cancelled'];

/**
 * Recomputes Razorpay's HMAC over order_id|payment_id. Returns true only when
 * the client's signature matches, which is the only proof the money moved.
 */
const verifyRazorpaySignature = (payment) => {
  if (!payment?.razorpay_order_id || !payment?.razorpay_payment_id || !payment?.razorpay_signature) {
    return false;
  }
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${payment.razorpay_order_id}|${payment.razorpay_payment_id}`)
    .digest('hex');
  // Constant-time compare; lengths must match or timingSafeEqual throws.
  const a = Buffer.from(expected);
  const b = Buffer.from(String(payment.razorpay_signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// PATCH /api/orders/:id/status — vendor only
router.patch('/:id/status', requireVendor, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'Missing status' });
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    // A vendor may only move its own outlet's orders.
    const existing = await Order.findById(req.params.id).select('restaurantId');
    if (!existing) return res.status(404).json({ message: 'Order not found' });
    if (!ownsOutlet(req.user, existing.restaurantId)) {
      return res.status(403).json({ message: 'You can only manage your own orders' });
    }

    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Emit status change to restaurant room
    try {
      const io = req.app.get('io');
      if (io && order.restaurantId) {
        io.to(`restaurant:${order.restaurantId}`).emit('order.statusChanged', { orderId: order._id, status });
      }
    } catch (emitErr) {
      console.warn('Emit order.statusChanged failed', emitErr);
    }

    res.json({ order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/orders/validate — the pre-payment gate.
//
// Orders are prepaid, so a closed outlet must be caught BEFORE the customer is
// charged — rejecting after payment would strand their money. The app calls
// this the instant they tap pay; if anything is closed it blocks and never
// opens the payment sheet. Returns the outlets that can't currently take orders.
router.post('/validate', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.restaurantIds) ? req.body.restaurantIds : [];
    if (!ids.length) return res.status(400).json({ message: 'No outlets to validate' });

    const settings = await Settings.get();
    if (!settings.orderingEnabled) {
      return res.json({
        ok: false,
        reason: 'platform_paused',
        message: settings.pausedMessage || 'Ordering is paused right now. Please try again later.',
        closed: [],
      });
    }

    const restaurants = await Restaurant.find({ _id: { $in: ids } }).select('name isOpen').lean();
    const byId = new Map(restaurants.map((r) => [String(r._id), r]));

    const closed = ids
      .map((id) => byId.get(String(id)))
      .filter((r) => !r || r.isOpen === false)
      .map((r) => (r ? r.name : 'An outlet'));

    if (closed.length) {
      const names = closed.join(', ');
      return res.json({
        ok: false,
        reason: 'outlet_closed',
        message:
          closed.length === 1
            ? `${names} just closed and can't take orders right now. Remove its items to continue.`
            : `${names} are closed right now. Remove their items to continue.`,
        closed,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Validate order failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/orders
router.post('/', async (req, res) => {
  try {
    const io = req.app.get('io');
    const { restaurantId, items, pickupType, scheduledAt, notes, customer, payment } = req.body;
    if (!restaurantId || !items || !items.length) return res.status(400).json({ message: 'Missing order data' });

    // Orders are prepaid: no verified payment, no order. The client claiming
    // "it went through" is not evidence — the signature is recomputed here.
    if (!verifyRazorpaySignature(payment)) {
      return res.status(400).json({ message: 'Payment could not be verified' });
    }

    // Never trust client totals — price the order from its line items here.
    const { subtotal, total } = priceOrder(items);

    const order = new Order({
      restaurantId,
      items,
      subtotal,
      total,
      pickupType,
      scheduledAt,
      notes,
      customer,
      paidAt: new Date(),
      razorpayOrderId: payment.razorpay_order_id,
      razorpayPaymentId: payment.razorpay_payment_id,
      status: 'pending',
    });

    await order.save();

    // Populate restaurantId (only name) so client receives the name instead of raw id
    try {
      await order.populate('restaurantId', 'name');
    } catch (popErr) {
      console.warn('Populate restaurant name failed', popErr);
    }

    // Emit to restaurant channel if io available — include full order object
    try {
      if (io) {
        io.to(`restaurant:${restaurantId}`).emit('order.created', {
          _id: order._id,
          orderId: order._id,
          restaurantId: order.restaurantId._id,
          restaurantName: order.restaurantId?.name,
          items: order.items,
          subtotal: order.subtotal,
          total: order.total,
          customer: order.customer,
          createdAt: order.createdAt,
          status: order.status,
          source: order.source, // ONLINE — the live panel filters on this
        });
      }
    } catch (emitErr) {
      console.error('Emit error', emitErr);
    }

    // Notifications removed

    res.status(201).json({ order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/orders/pos — a counter sale rung up by the vendor.
//
// Separate from online orders in every way: the vendor collected the money
// directly (cash/UPI/card/other), so there is no Razorpay step and no
// settlement — it is created paid and settled, and completed on the spot. Only
// an outlet the admin has granted POS access can use it.
const POS_METHODS = ['cash', 'upi', 'card', 'other'];
router.post('/pos', requireVendor, async (req, res) => {
  try {
    const { restaurantId, items, posPaymentMethod, customer, notes } = req.body;
    if (!restaurantId || !items || !items.length) return res.status(400).json({ message: 'Missing order data' });
    if (!ownsOutlet(req.user, restaurantId)) {
      return res.status(403).json({ message: 'You can only sell from your own outlet' });
    }
    if (!POS_METHODS.includes(posPaymentMethod)) {
      return res.status(400).json({ message: 'Choose a payment method' });
    }

    const restaurant = await Restaurant.findById(restaurantId).select('posEnabled name');
    if (!restaurant) return res.status(404).json({ message: 'Outlet not found' });
    if (!restaurant.posEnabled) {
      return res.status(403).json({ message: 'POS is not enabled for this outlet' });
    }

    const { subtotal, total } = priceOrder(items);
    const now = new Date();

    const order = await Order.create({
      restaurantId,
      items,
      subtotal,
      total,
      source: 'POS',
      posPaymentMethod,
      notes,
      customer: customer && customer.name ? { name: customer.name, phone: customer.phone } : undefined,
      paidAt: now,
      // The vendor already holds the cash, so it's settled by definition and the
      // sale is done the moment it's rung up.
      settlementStatus: 'settled',
      settledAt: now,
      status: 'delivered',
    });

    res.status(201).json({ order });
  } catch (err) {
    console.error('POS order failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET orders by customer phone
router.get('/user/:phone', async (req, res) => {
  try {
    // Populate restaurantId to include restaurant name for client dislay
    const orders = await Order.find({ 'customer.phone': req.params.phone })
      .sort({ createdAt: -1 })
      .populate('restaurantId', 'name');
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET orders for restaurant (vendor) - paginated — vendor only
router.get('/restaurant/:id', requireVendor, async (req, res) => {
  try {
    if (!ownsOutlet(req.user, req.params.id)) {
      return res.status(403).json({ message: 'You can only read your own orders' });
    }
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    const filter = { restaurantId: req.params.id };
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    // The dashboard requests one lane at a time: ONLINE for the live panel,
    // POS for the counter history/analytics.
    if (req.query.source === 'ONLINE' || req.query.source === 'POS') {
      filter.source = req.query.source;
    }
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    res.json({ orders, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET all orders across every outlet, with customer details — admin only.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .populate('restaurantId', 'name');
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
