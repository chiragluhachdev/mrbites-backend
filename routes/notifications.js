const express = require('express');
const Notification = require('../models/Notification');
const { requireAdmin } = require('../middleware/auth');
const { notifyUsers, notifyAll } = require('../utils/pushNotify');

const router = express.Router();

/** Actually sends a notification doc's payload to its audience, then records
 * the outcome. Shared by the immediate-send path and the scheduler. */
async function dispatch(doc) {
  doc.status = 'sending';
  await doc.save();

  const payload = {
    title: doc.title,
    body: doc.body,
    image: doc.image || undefined,
    data: { screen: doc.data?.screen || '', type: doc.data?.type || 'announcement', notificationId: String(doc._id) },
  };

  try {
    const result = doc.audience === 'selected'
      ? await notifyUsers(doc.userIds, payload)
      : await notifyAll(payload);

    doc.status = 'sent';
    doc.sentAt = new Date();
    doc.sentCount = result.successCount;
    doc.failedCount = result.failureCount;
  } catch (err) {
    console.error('[notifications] dispatch failed', err.message);
    doc.status = 'failed';
  }
  await doc.save();
  return doc;
}

// POST /api/notifications/admin/send — compose + send (or schedule) a broadcast.
router.post('/admin/send', requireAdmin, async (req, res) => {
  try {
    const { title, body, image, screen, type, audience, userIds, scheduledAt } = req.body || {};

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ message: 'Title and message are required' });
    }
    if (!['all', 'selected'].includes(audience)) {
      return res.status(400).json({ message: "audience must be 'all' or 'selected'" });
    }
    if (audience === 'selected' && !Array.isArray(userIds)) {
      return res.status(400).json({ message: 'userIds is required when audience is "selected"' });
    }

    const scheduled = scheduledAt ? new Date(scheduledAt) : null;
    if (scheduled && Number.isNaN(scheduled.getTime())) {
      return res.status(400).json({ message: 'Invalid scheduledAt' });
    }
    // A "scheduled" time in the past (or right now) is just an instant send —
    // no reason to make the admin wait on the poller for something already due.
    const isFuture = scheduled && scheduled.getTime() > Date.now() + 5000;

    let doc = await Notification.create({
      title: title.trim(),
      body: body.trim(),
      image: image?.trim() || undefined,
      data: { screen: screen || '', type: type || 'announcement' },
      audience,
      userIds: audience === 'selected' ? userIds : [],
      scheduledAt: isFuture ? scheduled : undefined,
      status: 'scheduled',
    });

    if (!isFuture) doc = await dispatch(doc);

    res.status(201).json({ notification: doc });
  } catch (err) {
    console.error('Failed to send notification', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/notifications/admin/history — paginated, newest first.
router.get('/admin/history', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      Notification.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(),
    ]);
    res.json({ notifications, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error('Failed to fetch notification history', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/notifications/admin/:id — cancel a still-scheduled send.
router.delete('/admin/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await Notification.findOne({ _id: req.params.id, status: 'scheduled' });
    if (!doc) return res.status(404).json({ message: 'No scheduled notification with that id' });
    await Notification.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to cancel notification', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.dispatch = dispatch; // shared with the scheduler
module.exports = router;
