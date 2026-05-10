const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
// QR verification removed; bcrypt not required

// PATCH /api/orders/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'Missing status' });
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    // Notifications removed
    res.json({ order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/orders
router.post('/', async (req, res) => {
  try {
    const io = req.app.get('io');
    const { restaurantId, items, subtotal, platformFee, tax, total, pickupType, scheduledAt, notes, customer } = req.body;
    if (!restaurantId || !items || !items.length) return res.status(400).json({ message: 'Missing order data' });

    // server-side calculation sanity: recompute subtotal
    const calcSubtotal = items.reduce((s, it) => s + (it.price || 0) * (it.qty || 0), 0);
    const calcTax = Math.round(calcSubtotal * 0.02);
    const calcPlatform = Number(platformFee || 5);
    const calcTotal = calcSubtotal + calcTax + calcPlatform;

    // QR delivery code removed; no deliveryCodeHash stored

    const order = new Order({
      restaurantId,
      items,
      subtotal: calcSubtotal,
      platformFee: calcPlatform,
      tax: calcTax,
      total: calcTotal,
      pickupType,
      scheduledAt,
      notes,
      customer,
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
          platformFee: order.platformFee,
          tax: order.tax,
          total: order.total,
          customer: order.customer,
          createdAt: order.createdAt,
          status: order.status
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

// GET orders for restaurant (vendor) - not paginated, simple
router.get('/restaurant/:id', async (req, res) => {
  try {
    const orders = await Order.find({ restaurantId: req.params.id }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET all orders (for admin analytics)
router.get('/', async (req, res) => {
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
