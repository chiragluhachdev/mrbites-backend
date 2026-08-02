const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  // Empty for someone who signed in by OTP without ever signing up — the app
  // asks them for it rather than inventing a placeholder like "User".
  name: { type: String, default: '', trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  // FCM registration tokens, one per device. An array (not a single field) so a
  // user signed in on both a phone and a tablet gets order updates on both —
  // sending pushes them to every token on file, and any token FCM reports back
  // as no-longer-registered is pruned automatically (see utils/pushNotify.js).
  pushTokens: {
    type: [{
      token: { type: String, required: true },
      platform: { type: String, enum: ['ios', 'android'] },
      updatedAt: { type: Date, default: Date.now },
      _id: false,
    }],
    default: [],
  },
  // The app-store review account. Checkout is always demo for this user, even
  // when the global demo switch is off, so a reviewer can complete the flow at
  // any time without a real card and without an admin having to flip anything.
  isDemo: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);