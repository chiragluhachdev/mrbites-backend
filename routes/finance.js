const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const { requireVendor, requireAdmin } = require('../middleware/auth');
const { round2 } = require('../utils/pricing');

const router = express.Router();

// MR-Bites takes no commission. Students pay the menu price, and the vendor is
// owed every rupee of it. The only reason money needs tracking is that online
// payments are collected into the platform's Razorpay account, so the platform
// holds vendor money until an admin pays it across.
//
// A cancelled order is assumed refunded, so it counts as neither collection nor
// payout.
//
// Settlement is an ONLINE-only concern: POS money was paid straight to the
// vendor and the platform never held it, so it can never be "owed". `$ne: 'POS'`
// also sweeps in legacy orders saved before the source field existed.
const EARNING = { status: { $ne: 'cancelled' }, source: { $ne: 'POS' } };
const POS_EARNING = { status: { $ne: 'cancelled' }, source: 'POS' };

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

/** Reads ?from=&to= (YYYY-MM-DD, local days), defaulting to today. */
const dateRange = (query) => {
  const from = query.from ? startOfDay(query.from) : startOfDay(new Date());
  const to = query.to ? endOfDay(query.to) : endOfDay(query.from || new Date());
  return { from, to };
};

const sum = (orders, pick = (o) => o.total) => round2(orders.reduce((s, o) => s + pick(o), 0));

/**
 * Payout details safe to send to a client: the account number is replaced by
 * its last four digits and never leaves the server in full.
 */
const publicPayout = (payout = {}) => {
  const { accountNumber, ...rest } = payout;
  return {
    ...rest,
    accountNumberLast4: accountNumber ? String(accountNumber).slice(-4) : '',
  };
};

/* ------------------------------------------------------------------ vendor */

// GET /api/finance/vendor — earnings for the signed-in vendor's own outlet.
router.get('/vendor', requireVendor, async (req, res) => {
  try {
    // A vendor token is scoped to one outlet and can never read another's.
    // Admins may pass ?restaurantId= to inspect any outlet.
    const restaurantId = req.user.role === 'admin' ? req.query.restaurantId : req.user.restaurantId;
    if (!restaurantId) return res.status(400).json({ message: 'Missing restaurantId' });

    const rid = new mongoose.Types.ObjectId(String(restaurantId));
    const scope = { restaurantId: rid, ...EARNING };
    const { from, to } = dateRange(req.query);

    const [inRange, pending, settled, posInRange, restaurant] = await Promise.all([
      Order.find({ ...scope, paidAt: { $gte: from, $lte: to } }).sort({ paidAt: -1 }).lean(),
      Order.find({ ...scope, settlementStatus: 'pending' }).lean(),
      Order.find({ ...scope, settlementStatus: 'settled' }).lean(),
      // POS sales in the same window — the vendor already holds this cash, so it
      // is reported as a separate tally, never as pending settlement.
      Order.find({ restaurantId: rid, ...POS_EARNING, paidAt: { $gte: from, $lte: to } }).lean(),
      // The account number is select:false, so ask for it explicitly and mask it
      // before it goes out.
      Restaurant.findById(restaurantId).select('+payout.accountNumber').lean(),
    ]);

    // POS split by how it was paid, for the vendor's own reconciliation.
    const posByMethod = {};
    posInRange.forEach((o) => {
      const m = o.posPaymentMethod || 'other';
      posByMethod[m] = round2((posByMethod[m] || 0) + o.total);
    });

    res.json({
      range: { from, to },
      outlet: restaurant
        ? { id: restaurant._id, name: restaurant.name, payout: publicPayout(restaurant.payout) }
        : null,
      // Online sales in the requested window.
      sales: { orders: inRange.length, gross: sum(inRange) },
      // Owed but not yet paid across — the whole point of this screen.
      pendingSettlement: { orders: pending.length, amount: sum(pending) },
      totalSettled: { orders: settled.length, amount: sum(settled) },
      // Counter sales, collected directly by the vendor.
      pos: { orders: posInRange.length, gross: sum(posInRange), byMethod: posByMethod },
      orders: inRange.map((o) => ({
        id: o._id,
        paidAt: o.paidAt,
        customer: o.customer,
        items: o.items.length,
        total: o.total,
        status: o.status,
        settlementStatus: o.settlementStatus,
        settledAt: o.settledAt,
      })),
    });
  } catch (err) {
    console.error('Vendor finance failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ------------------------------------------------------------------- admin */

// GET /api/finance/admin — collections and what is owed to each outlet.
router.get('/admin', requireAdmin, async (req, res) => {
  try {
    const { from, to } = dateRange(req.query);

    const [inRange, pendingAll, settledAll, restaurants] = await Promise.all([
      Order.find({ ...EARNING, paidAt: { $gte: from, $lte: to } })
        .sort({ paidAt: -1 })
        .populate('restaurantId', 'name')
        .lean(),
      Order.find({ ...EARNING, settlementStatus: 'pending' }).populate('restaurantId', 'name').lean(),
      Order.find({ ...EARNING, settlementStatus: 'settled' }).lean(),
      Restaurant.find().select('name').lean(),
    ]);

    const collection = sum(inRange);

    // What is owed per outlet right now — this drives the settlements panel and
    // is deliberately not limited to the date range: a debt is a debt.
    const byOutlet = new Map();
    pendingAll.forEach((o) => {
      const id = String(o.restaurantId?._id || o.restaurantId);
      const entry = byOutlet.get(id) || {
        restaurantId: id,
        name: o.restaurantId?.name || 'Unknown outlet',
        orders: 0,
        amount: 0,
      };
      entry.orders += 1;
      entry.amount = round2(entry.amount + o.total);
      byOutlet.set(id, entry);
    });

    const settlements = [...byOutlet.values()].sort((a, b) => b.amount - a.amount);

    res.json({
      range: { from, to },
      totals: {
        collection,
        paidOrders: inRange.length,
        avgOrderValue: inRange.length ? round2(collection / inRange.length) : 0,
        // Everything collected belongs to the vendors; MR-Bites keeps nothing.
        payoutDue: sum(pendingAll),
        settledPayout: sum(settledAll),
      },
      settlements,
      outlets: restaurants.map((r) => ({ id: r._id, name: r.name })),
      orders: inRange.map((o) => ({
        id: o._id,
        paidAt: o.paidAt,
        outlet: o.restaurantId?.name || 'Unknown outlet',
        restaurantId: o.restaurantId?._id || o.restaurantId,
        customer: o.customer,
        items: o.items.length,
        total: o.total,
        status: o.status,
        settlementStatus: o.settlementStatus,
      })),
    });
  } catch (err) {
    console.error('Admin finance failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/finance/settle — mark an outlet's outstanding orders as paid out.
// Settlement is a manual bank transfer; this only records that it happened.
router.post('/settle', requireAdmin, async (req, res) => {
  try {
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ message: 'Missing restaurantId' });

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) return res.status(404).json({ message: 'Outlet not found' });

    const outstanding = await Order.find({
      restaurantId,
      settlementStatus: 'pending',
      ...EARNING,
    }).lean();

    if (!outstanding.length) {
      return res.status(400).json({ message: 'Nothing outstanding for this outlet' });
    }

    const settledAt = new Date();
    const result = await Order.updateMany(
      { _id: { $in: outstanding.map((o) => o._id) } },
      { settlementStatus: 'settled', settledAt }
    );

    res.json({
      message: `Settled ${result.modifiedCount} order(s) for ${restaurant.name}`,
      orders: result.modifiedCount,
      amount: sum(outstanding),
      settledAt,
    });
  } catch (err) {
    console.error('Settle failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
