const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const Settlement = require('../models/Settlement');
const { requireVendor, requireAdmin } = require('../middleware/auth');
const { round2 } = require('../utils/pricing');
const { istDateRange, dayKeyIST, IST_TIMEZONE } = require('../utils/time');

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

// Days are IST days, not the server's.
//
// These used to be `setHours(0,0,0,0)` in whatever timezone the host happened to
// run in. On a UTC box that rolls the day at 05:30 IST, so a 1am sale landed in
// yesterday's report and the totals here never matched what a vendor counted at
// the till. `istDateRange` pins the boundary to the business, wherever it is
// deployed, and the frontend uses the same rule so both agree on "Today".
const dateRange = istDateRange;

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
    if (!mongoose.isValidObjectId(String(restaurantId))) {
      // Casting an unchecked value straight to an ObjectId throws, which
      // surfaced as a 500 on what is really a bad request.
      return res.status(400).json({ message: 'Invalid restaurantId' });
    }

    const rid = new mongoose.Types.ObjectId(String(restaurantId));
    const scope = { restaurantId: rid, ...EARNING };
    const { from, to } = dateRange(req.query);

    // Projections matter here. These queries used to pull whole documents —
    // every line item of every order — when all that is wanted is a column to
    // sum. On an outlet with a few thousand orders that is megabytes off the
    // database and through Node's JSON encoder to produce one number.
    const [inRange, pending, settled, posInRange, restaurant] = await Promise.all([
      Order.find({ ...scope, paidAt: { $gte: from, $lte: to } })
        .select('paidAt customer total status settlementStatus settledAt items.name')
        .sort({ paidAt: -1 })
        .lean(),
      // Only ever summed and counted.
      Order.find({ ...scope, settlementStatus: 'pending' }).select('total').lean(),
      Order.find({ ...scope, settlementStatus: 'settled' }).select('total').lean(),
      // POS sales in the same window — the vendor already holds this cash, so it
      // is reported as a separate tally, never as pending settlement.
      Order.find({ restaurantId: rid, ...POS_EARNING, paidAt: { $gte: from, $lte: to } })
        .select('total posPaymentMethod')
        .lean(),
      // Every payout field is select:false so the public outlet listing can
      // never leak them. This is the one screen entitled to them, so ask
      // explicitly — and the account number is still masked on the way out.
      Restaurant.findById(restaurantId)
        .select('name +payout.accountNumber +payout.accountHolder +payout.ifsc +payout.bankName +payout.pan')
        .lean(),
    ]);

    // POS split by how it was paid, for the vendor's own reconciliation.
    const posByMethod = {};
    posInRange.forEach((o) => {
      const m = o.posPaymentMethod || 'other';
      posByMethod[m] = round2((posByMethod[m] || 0) + o.total);
    });

    res.json({
      range: { from, to, timezone: IST_TIMEZONE },
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
        .select('paidAt customer total status settlementStatus restaurantId items.name')
        .sort({ paidAt: -1 })
        .populate('restaurantId', 'name')
        .lean(),
      // Grouped per outlet and summed — the id and the amount are all that is read.
      Order.find({ ...EARNING, settlementStatus: 'pending' })
        .select('total restaurantId')
        .populate('restaurantId', 'name')
        .lean(),
      // Summed only.
      Order.find({ ...EARNING, settlementStatus: 'settled' }).select('total').lean(),
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
      range: { from, to, timezone: IST_TIMEZONE },
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

// POST /api/finance/settle — record that an outlet's outstanding orders were
// paid out. Settlement is a manual bank transfer; this only books it.
//
// The previous version read the outstanding orders, updated them unconditionally
// by id, then reported the *snapshot's* total. Two admins clicking at once — or
// one double-click — would both be told the full amount had settled, because
// neither reported what it had actually claimed. An admin paying against those
// confirmations pays twice.
//
// Now the update itself is the claim: it filters on `settlementStatus: 'pending'`
// and stamps a settlementId, so each order can be claimed exactly once. The
// amount is then counted from the orders this call really took. A concurrent
// second call claims nothing and is told so.
router.post('/settle', requireAdmin, async (req, res) => {
  try {
    const { restaurantId, reference, note } = req.body;
    if (!restaurantId || !mongoose.isValidObjectId(String(restaurantId))) {
      return res.status(400).json({ message: 'Missing or invalid restaurantId' });
    }

    const restaurant = await Restaurant.findById(restaurantId).select('name').lean();
    if (!restaurant) return res.status(404).json({ message: 'Outlet not found' });

    const settlementId = new mongoose.Types.ObjectId();
    const settledAt = new Date();

    // Claim: only rows still pending are taken, and they are marked with this
    // settlement's id so we can count exactly what we got.
    await Order.updateMany(
      { restaurantId, settlementStatus: 'pending', ...EARNING },
      { settlementStatus: 'settled', settledAt, settlementId }
    );

    const claimed = await Order.find({ settlementId }).select('_id total').lean();

    if (!claimed.length) {
      return res.status(400).json({ message: 'Nothing outstanding for this outlet' });
    }

    const amount = sum(claimed);

    const settlement = await Settlement.create({
      _id: settlementId,
      restaurantId,
      restaurantName: restaurant.name,
      orderIds: claimed.map((o) => o._id),
      orderCount: claimed.length,
      amount,
      dayKey: dayKeyIST(settledAt),
      reference: (reference || '').trim(),
      note: (note || '').trim(),
      settledAt,
    });

    res.json({
      message: `Settled ${claimed.length} order(s) for ${restaurant.name}`,
      settlementId: settlement._id,
      orders: claimed.length,
      amount,
      settledAt,
    });
  } catch (err) {
    console.error('Settle failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/finance/settlements — the payout history, newest first.
router.get('/settlements', requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.restaurantId && mongoose.isValidObjectId(String(req.query.restaurantId))) {
      filter.restaurantId = req.query.restaurantId;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const settlements = await Settlement.find(filter).sort({ settledAt: -1 }).limit(limit).lean();
    res.json({ settlements });
  } catch (err) {
    console.error('Fetch settlements failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
