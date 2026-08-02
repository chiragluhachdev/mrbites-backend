const mongoose = require('mongoose');

// An admin-composed push broadcast — instant or scheduled — plus the record of
// what happened when it (or will) go out. Order-lifecycle pushes (confirmed,
// preparing, ready, delivered, cancelled) do NOT create one of these; they're
// sent directly from the order routes via utils/pushNotify.js and aren't
// something an admin composes, so they don't belong in this history.
const NotificationSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  image: { type: String, trim: true },
  // Free-form beyond `screen` — mirrors what a mobile deep link needs to
  // decide where to navigate on tap.
  data: {
    screen: { type: String, trim: true }, // e.g. 'Home', 'YourOrders'
    type: { type: String, trim: true, default: 'announcement' },
  },
  audience: { type: String, enum: ['all', 'selected'], required: true },
  // Only meaningful when audience === 'selected'.
  userIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },

  // Unset = send immediately. Set in the future = held for the scheduler.
  scheduledAt: { type: Date },
  status: { type: String, enum: ['scheduled', 'sending', 'sent', 'failed'], default: 'scheduled' },
  sentAt: { type: Date },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  // No per-admin accounts exist (a single shared passkey), so this is just a
  // label, not a reference.
  createdBy: { type: String, default: 'admin' },
}, { timestamps: true });

NotificationSchema.index({ status: 1, scheduledAt: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
