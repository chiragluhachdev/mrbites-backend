const express = require('express');
const Settings = require('../models/Settings');
const { requireAdmin } = require('../middleware/auth');
const { invalidate: invalidatePushCopy } = require('../utils/orderPushCopy');

const router = express.Router();

// The six order-stage templates, in the order a customer meets them.
const TEMPLATE_KEYS = ['pending', 'preparing', 'readyDineIn', 'readyPickup', 'delivered', 'cancelled'];

const publicSettings = (s) => ({
  orderingEnabled: s.orderingEnabled,
  pausedMessage: s.pausedMessage,
  ratingsEnabled: s.ratingsEnabled,
  // Not sensitive — the app learns the active gateway from create-order anyway,
  // and the admin dashboard needs it to show the current selection.
  paymentGateway: s.paymentGateway,
  minAppVersion: s.minAppVersion,
  updateMessage: s.updateMessage,
  // Admin-only in practice (the app never reads these), but harmless to expose
  // and it keeps the admin console on one settings fetch.
  orderNotifications: s.orderNotifications,
});

// GET /api/settings — public: the app needs to know whether ordering is live.
router.get('/', async (req, res) => {
  try {
    const s = await Settings.get();
    res.json({ settings: publicSettings(s) });
  } catch (err) {
    console.error('Read settings failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/settings — admin only.
router.put('/', requireAdmin, async (req, res) => {
  try {
    const { orderingEnabled, pausedMessage, ratingsEnabled, paymentGateway, minAppVersion, updateMessage, orderNotifications } = req.body || {};
    const updates = {};
    if (typeof orderingEnabled === 'boolean') updates.orderingEnabled = orderingEnabled;
    if (typeof ratingsEnabled === 'boolean') updates.ratingsEnabled = ratingsEnabled;
    if (typeof pausedMessage === 'string') updates.pausedMessage = pausedMessage.trim();
    if (paymentGateway === 'cashfree' || paymentGateway === 'razorpay') updates.paymentGateway = paymentGateway;
    if (typeof minAppVersion === 'string') updates.minAppVersion = minAppVersion.trim();
    if (typeof updateMessage === 'string') updates.updateMessage = updateMessage.trim();

    // Order-stage push templates. Written per-field with dot paths so a partial
    // payload (say, just the master switch) can't wipe the other templates.
    if (orderNotifications && typeof orderNotifications === 'object') {
      if (typeof orderNotifications.enabled === 'boolean') {
        updates['orderNotifications.enabled'] = orderNotifications.enabled;
      }
      for (const key of TEMPLATE_KEYS) {
        const tpl = orderNotifications[key];
        if (!tpl || typeof tpl !== 'object') continue;
        if (typeof tpl.enabled === 'boolean') updates[`orderNotifications.${key}.enabled`] = tpl.enabled;
        // A blank title/body would silently produce an empty notification, so
        // only non-empty text is accepted; clearing a stage is what its own
        // `enabled` toggle is for.
        if (typeof tpl.title === 'string' && tpl.title.trim()) {
          updates[`orderNotifications.${key}.title`] = tpl.title.trim();
        }
        if (typeof tpl.body === 'string' && tpl.body.trim()) {
          updates[`orderNotifications.${key}.body`] = tpl.body.trim();
        }
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const settings = await Settings.findOneAndUpdate({ key: 'platform' }, updates, {
      new: true,
      upsert: true,
    });

    // Drop the push-copy cache so an edited template is used by the very next
    // order update rather than waiting out its TTL.
    invalidatePushCopy();

    // The global ratings switch changes what every customer sees, so nudge the
    // apps to refetch by broadcasting it.
    try {
      const io = req.app.get('io');
      if (io) io.emit('settings.updated', publicSettings(settings));
    } catch (emitErr) {
      console.warn('Emit settings.updated failed', emitErr);
    }

    res.json({ settings: publicSettings(settings) });
  } catch (err) {
    console.error('Update settings failed', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
