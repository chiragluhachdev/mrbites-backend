const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  // Empty for someone who signed in by OTP without ever signing up — the app
  // asks them for it rather than inventing a placeholder like "User".
  name: { type: String, default: '', trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  // Expo push token for this user (optional)
  pushToken: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);