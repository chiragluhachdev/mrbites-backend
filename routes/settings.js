const express = require('express');
const Settings = require('../models/Settings');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const publicSettings = (s) => ({
  orderingEnabled: s.orderingEnabled,
  pausedMessage: s.pausedMessage,
  ratingsEnabled: s.ratingsEnabled,
  demoMode: !!s.demoMode,
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
    const { orderingEnabled, pausedMessage, ratingsEnabled, demoMode } = req.body || {};
    const updates = {};
    if (typeof orderingEnabled === 'boolean') updates.orderingEnabled = orderingEnabled;
    if (typeof ratingsEnabled === 'boolean') updates.ratingsEnabled = ratingsEnabled;
    if (typeof demoMode === 'boolean') updates.demoMode = demoMode;
    if (typeof pausedMessage === 'string') updates.pausedMessage = pausedMessage.trim();

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const settings = await Settings.findOneAndUpdate({ key: 'platform' }, updates, {
      new: true,
      upsert: true,
    });

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
