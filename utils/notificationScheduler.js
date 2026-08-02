const Notification = require('../models/Notification');

/**
 * Runs continuously in the background to send scheduled admin broadcasts once
 * their scheduledAt time arrives. Mirrors orderScheduler.js's polling shape.
 */
function startNotificationScheduler() {
  // Required lazily so this file has no hard dependency on the admin routes
  // module load order.
  const { dispatch } = require('../routes/notifications');

  setInterval(async () => {
    try {
      const due = await Notification.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } });
      for (const doc of due) {
        await dispatch(doc);
      }
      if (due.length) console.log(`[NotificationScheduler] Sent ${due.length} scheduled notification(s).`);
    } catch (err) {
      console.error('[NotificationScheduler] Error sending scheduled notifications:', err);
    }
  }, 30000); // every 30s — a broadcast isn't as time-critical as an order timeout
}

module.exports = { startNotificationScheduler };
