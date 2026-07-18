const mongoose = require('mongoose');

// One live code per number, and how many times someone has guessed at it.
//
// Two invariants matter here, and both are enforced structurally rather than
// hoped for in application code:
//
//   1. At most one code per number, ever. The unique index on `phone` makes a
//      second concurrent create impossible — the losing racer gets a duplicate
//      key error, which utils/otp turns into "reuse the existing code". Without
//      it, two near-simultaneous sends each inserted a different code and the
//      verifier's findOne could hand back the one the user never received.
//
//   2. The attempt counter caps guesses per delivered SMS. Six digits is a
//      million combinations; unthrottled that is account takeover, and the same
//      path guards changing a number and deleting an account.
//
// `createdAt` fixes the lifetime (a resend reuses the code and does NOT reset
// it, so expiry always runs from first issue); `lastSentAt` moves on every send
// and drives the resend cooldown. Separating them lets the code live five
// minutes while still throttling how often a text goes out.

const OTP_TTL_SECONDS = 300; // 5 minutes
const MAX_OTP_ATTEMPTS = 5;

const otpSchema = new mongoose.Schema({
  // Unique: the whole race fix rests on there being at most one row per number.
  phone: {
    type: String,
    required: true,
    unique: true,
  },
  otp: {
    type: String,
    required: true,
  },
  // Wrong guesses so far. At MAX_OTP_ATTEMPTS the code is burned and a new one
  // must be requested, which puts a hard ceiling on guesses per delivered SMS.
  attempts: {
    type: Number,
    default: 0,
  },
  // When the last text actually went out — drives the resend cooldown. Bumped on
  // every (re)send; deliberately separate from createdAt.
  lastSentAt: {
    type: Date,
    default: Date.now,
  },
  // First issued. The TTL index sweeps the row this many seconds later, and it
  // is never reset on resend, so a code's five minutes always run from here.
  createdAt: {
    type: Date,
    default: Date.now,
    expires: OTP_TTL_SECONDS,
  },
});

const Otp = mongoose.model('Otp', otpSchema);

module.exports = Otp;
module.exports.OTP_TTL_SECONDS = OTP_TTL_SECONDS;
module.exports.MAX_OTP_ATTEMPTS = MAX_OTP_ATTEMPTS;
