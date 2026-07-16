const mongoose = require('mongoose');

// A single platform-wide settings document. There is only ever one row; it is
// created on first read.
const SettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'platform', unique: true },

  // Master switch. When false, every outlet reads as closed to students —
  // useful for exam weeks, holidays, or a bad day. Individual outlets keep
  // their own isOpen flag underneath, so nothing is lost when it flips back.
  orderingEnabled: { type: Boolean, default: true },
  // Shown to students when ordering is paused.
  pausedMessage: { type: String, default: 'Ordering is paused right now. Please check back later.' },

  // Master switch for outlet ratings. When false, no outlet shows a rating,
  // whatever its own ratingEnabled flag says.
  ratingsEnabled: { type: Boolean, default: true },
}, { timestamps: true });

/** Reads the singleton, creating it the first time. */
SettingsSchema.statics.get = async function () {
  return (await this.findOne({ key: 'platform' })) || this.create({ key: 'platform' });
};

module.exports = mongoose.model('Settings', SettingsSchema);
