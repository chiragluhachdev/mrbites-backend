const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const OrderDraft = require('../models/OrderDraft');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { authenticate, requireVendor, requireAdmin, ownsOutlet } = require('../middleware/auth');
const { priceOrder } = require('../utils/pricing');
const { priceCart } = require('../utils/priceCart');
const { razorpay, verifySignature } = require('../utils/razorpay');

const VALID_STATUSES = ['pending', 'preparing', 'ready', 'delivered', 'cancelled'];

// An order only ever moves forwards.
//
// Any status could previously be set from any other, so a delivered order could
// be dragged back to pending — by a stale tab replaying an old click, or by two
// devices in a kitchen disagreeing. That corrupts the vendor's queue and, since
// cancelled orders are excluded from earnings, un-cancelling one silently
// changes what the platform owes. Terminal states have no exits.
const STATUS_TRANSITIONS = {
  pending: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
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
    const existing = await Order.findById(req.params.id).select('restaurantId status');
    if (!existing) return res.status(404).json({ message: 'Order not found' });
    if (!ownsOutlet(req.user, existing.restaurantId)) {
      return res.status(403).json({ message: 'You can only manage your own orders' });
    }

    // Setting a status it already holds is a no-op, not an error — two taps on
    // "Ready" should not look like a failure to the vendor.
    if (existing.status === status) {
      const unchanged = await Order.findById(req.params.id);
      return res.json({ order: unchanged });
    }

    const allowed = STATUS_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(status)) {
      return res.status(409).json({
        message: `An order that is ${existing.status} cannot be marked ${status}.`,
      });
    }

    // Conditional on the status we just read: if another device moved this order
    // in between, that update is not overwritten — it loses the race cleanly
    // rather than silently clobbering.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, status: existing.status },
      { status },
      { new: true }
    );
    if (!order) {
      return res.status(409).json({ message: 'That order was just updated elsewhere. Refresh and try again.' });
    }

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

// POST /api/orders — retired.
//
// This route used to build orders from client-supplied items and prices, with a
// signature that proved only that *some* payment existed. It is replaced by
// /api/payment/create-order + /api/orders/confirm, which price the cart on the
// server and bind the payment to it. Kept as an explicit 410 so an older app
// build fails loudly with something a user can act on, rather than silently.
router.post('/', (req, res) => {
  res.status(410).json({ message: 'Please update the app to place orders.' });
});

/**
 * Sends the sanitised order payload to the outlet's live dashboard. Tolerates a
 * populated or raw restaurantId — the room name must be the id either way.
 */
const emitOrderCreated = (io, order) => {
  if (!io) return;
  try {
    const restaurantId = order.restaurantId?._id || order.restaurantId;
    io.to(`restaurant:${restaurantId}`).emit('order.created', {
      _id: order._id,
      orderId: order._id,
      restaurantId,
      restaurantName: order.restaurantId?.name,
      items: order.items,
      subtotal: order.subtotal,
      total: order.total,
      customer: order.customer,
      createdAt: order.createdAt,
      status: order.status,
      source: order.source, // ONLINE — the live panel filters on this
    });
  } catch (err) {
    console.warn('Emit order.created failed', err);
  }
};

/**
 * POST /api/orders/confirm — turns a paid draft into real orders.
 *
 * The client sends only Razorpay's three callback fields. Everything the orders
 * are built from — items, prices, outlets, the customer — comes from the draft
 * stored when the payment was opened, so what is charged and what is cooked can
 * never disagree.
 *
 * Three independent guards make this safe to call repeatedly, which matters
 * because the app retries it after a dropped connection:
 *   1. the draft's `consuming` claim, so two in-flight calls can't both proceed;
 *   2. a `consumed` draft short-circuits and returns the orders it already made;
 *   3. a unique (razorpayOrderId, restaurantId) index, which stops a duplicate
 *      at the database even if the first two are somehow bypassed.
 */
router.post('/confirm', authenticate, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  try {
    // 1. Is this really from Razorpay?
    if (!verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
      return res.status(400).json({ message: 'Payment could not be verified.' });
    }

    // 2. What was quoted, and is it this user's?
    const draft = await OrderDraft.findOne({ razorpayOrderId: razorpay_order_id });
    if (!draft) {
      return res.status(404).json({ message: 'We could not find this payment. Contact support if you were charged.' });
    }
    if (String(draft.userId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'This payment belongs to another account.' });
    }

    // 3. Already done? Hand back the same orders — never make more.
    if (draft.status === 'consumed') {
      const orders = await Order.find({ _id: { $in: draft.orderIds } }).populate('restaurantId', 'name');
      return res.json({ orders, idempotent: true });
    }

    // 4. Did the money actually arrive, and was it the right amount? The
    //    signature alone proves neither.
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (!payment || payment.order_id !== razorpay_order_id) {
      return res.status(400).json({ message: 'Payment could not be verified.' });
    }
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      return res.status(402).json({ message: 'Payment has not completed. Nothing was ordered.' });
    }
    const expectedPaise = Math.round(draft.total * 100);
    if (Number(payment.amount) !== expectedPaise) {
      console.error('Payment amount mismatch', { razorpay_order_id, paid: payment.amount, expected: expectedPaise });
      return res.status(400).json({ message: 'Payment amount did not match the order.' });
    }

    // 5. Claim the draft. Only one request wins this.
    const claimed = await OrderDraft.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id, status: 'awaiting_payment' },
      { status: 'consuming' },
      { new: true }
    );
    if (!claimed) {
      // Another call is mid-flight, or just finished.
      const fresh = await OrderDraft.findOne({ razorpayOrderId: razorpay_order_id });
      if (fresh?.status === 'consumed') {
        const orders = await Order.find({ _id: { $in: fresh.orderIds } }).populate('restaurantId', 'name');
        return res.json({ orders, idempotent: true });
      }
      return res.status(409).json({ message: 'This order is already being placed. Please wait a moment.' });
    }

    // 6. Build one order per outlet, entirely from the draft.
    const paidAt = new Date();
    const docs = claimed.groups.map((g) => ({
      restaurantId: g.restaurantId,
      items: g.items,
      subtotal: g.subtotal,
      total: g.total,
      source: 'ONLINE',
      pickupType: claimed.pickupType,
      notes: claimed.notes,
      customer: claimed.customer,
      paidAt,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      settlementStatus: 'pending',
      status: 'pending',
    }));

    try {
      await Order.insertMany(docs, { ordered: false });
    } catch (err) {
      // A duplicate key here means a racing call already created them, which is
      // exactly what the index is for — read them back rather than failing.
      const duplicate = err?.code === 11000 || err?.writeErrors?.some((e) => e.err?.code === 11000);
      if (!duplicate) {
        // Release the claim so a retry can pick it up.
        await OrderDraft.updateOne({ _id: claimed._id }, { status: 'awaiting_payment' });
        throw err;
      }
    }

    const orders = await Order.find({ razorpayOrderId: razorpay_order_id }).populate('restaurantId', 'name');

    // 7. Seal the draft, and keep it around long enough to answer a late retry.
    await OrderDraft.updateOne(
      { _id: claimed._id },
      {
        status: 'consumed',
        orderIds: orders.map((o) => o._id),
        razorpayPaymentId: razorpay_payment_id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }
    );

    // 8. Only now does the vendor learn of it — payment is fully verified.
    const io = req.app.get('io');
    orders.forEach((o) => emitOrderCreated(io, o));

    res.status(201).json({ orders });
  } catch (err) {
    console.error('Confirm order failed', { razorpay_order_id, err });
    res.status(500).json({ message: 'We could not place your order. If you were charged, it will be retried automatically.' });
  }
});

// POST /api/orders/demo — a no-payment order for the demo/review account.
//
// Same cart, same server-side pricing, same validation as a real order — so the
// flow a reviewer walks is genuinely the app's flow — but no Razorpay, no money,
// and an isDemo stamp that keeps it out of every view except the customer's own
// history. Only the demo account (isDemo flag on User) may use this; a normal
// user gets a 403 and must go through the real payment flow.
router.post('/demo', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('name phone isDemo').lean();
    if (!user) return res.status(401).json({ message: 'Please sign in again.' });

    if (!user.isDemo) {
      // Not the demo account — the client should be using the real payment flow.
      return res.status(403).json({ message: 'Demo checkout is not available for this account.' });
    }

    const priced = await priceCart(req.body?.items);
    if (!priced.ok) {
      return res.status(409).json({ reason: priced.reason, message: priced.message });
    }

    const now = new Date();
    const customer = { name: user.name?.trim() || 'User', phone: user.phone };
    const docs = priced.groups.map((g) => ({
      restaurantId: g.restaurantId,
      items: g.items,
      subtotal: g.subtotal,
      total: g.total,
      source: 'ONLINE',
      isDemo: true, // the flag that keeps this out of vendor/admin/finance
      pickupType: req.body?.pickupType === 'PICK_UP' ? 'PICK_UP' : 'DINE_IN',
      notes: req.body?.notes,
      customer,
      paidAt: now,
      // Settled with no obligation, belt-and-braces alongside the isDemo filters,
      // so a demo order can never read as money owed even if a filter is missed.
      settlementStatus: 'settled',
      settledAt: now,
      status: 'pending',
    }));

    // Deliberately NOT broadcast to the vendor room — a demo order is never a
    // real ticket to cook.
    const orders = await Order.insertMany(docs);
    const populated = await Order.find({ _id: { $in: orders.map((o) => o._id) } }).populate('restaurantId', 'name');

    res.status(201).json({ orders: populated, demo: true });
  } catch (err) {
    console.error('Demo order failed', err);
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

// GET /api/orders/mine — the signed-in customer's own order history.
//
// Scoped to the token's own phone number. The phone is never taken from the URL:
// this route previously accepted any number, so anyone could read a stranger's
// entire order history simply by guessing it.
router.get('/mine', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('phone').lean();
    if (!user) return res.status(401).json({ message: 'Please sign in again.' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const orders = await Order.find({ 'customer.phone': user.phone })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('restaurantId', 'name');
    res.json({ orders });
  } catch (err) {
    console.error('Fetch own orders failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Retired: this leaked any customer's history to anyone who knew their number.
router.get('/user/:phone', (req, res) => {
  res.status(410).json({ message: 'Please update the app.' });
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
    // Demo orders never reach a vendor — they are not real tickets.
    const filter = { restaurantId: req.params.id, isDemo: { $ne: true } };
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
    // Demo orders are excluded here too — the admin console reflects real trade.
    const orders = await Order.find({ isDemo: { $ne: true } })
      .sort({ createdAt: -1 })
      .populate('restaurantId', 'name');
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
