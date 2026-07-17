const mongoose = require('mongoose');

// A one-time code, and how many times someone has guessed at it.
//
// The counter is the whole point. Verification used to be a bare
// `findOne({ phone, otp })` with nothing limiting how often it could be called.
// Six digits is a million combinations, which an unthrottled endpoint will give
// up in minutes — that is account takeover for any user, and the same code path
// also guards changing a phone number and deleting an account. Counting attempts
// here, beside the code itself, means the limit holds whichever route checks it.

const OTP_TTL_SECONDS = 300; // 5 minutes
const MAX_OTP_ATTEMPTS = 5;

const otpSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
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
  createdAt: {
    type: Date,
    default: Date.now,
    expires: OTP_TTL_SECONDS,
  },
});

otpSchema.index({ phone: 1 });

const Otp = mongoose.model('Otp', otpSchema);

module.exports = Otp;
module.exports.OTP_TTL_SECONDS = OTP_TTL_SECONDS;
module.exports.MAX_OTP_ATTEMPTS = MAX_OTP_ATTEMPTS;
