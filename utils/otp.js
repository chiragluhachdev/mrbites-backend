const crypto = require('crypto');
const Otp = require('../models/Otp');

const { MAX_OTP_ATTEMPTS } = Otp;

// One place that knows how an OTP is checked.
//
// Three routes consume OTPs — sign-in, changing a phone number, and deleting an
// account — and each used to do its own `findOne({ phone, otp })`. Any limit
// added to one would have silently left the others open, so the check lives here
// instead and every caller inherits it.

/** A six-digit code. crypto rather than Math.random: this is a credential. */
const generateOtp = () => String(crypto.randomInt(100000, 1000000));

/**
 * Consumes an OTP.
 *
 * A correct code is deleted immediately, so it cannot be replayed. A wrong one
 * increments the attempt counter and, once the ceiling is reached, burns the
 * code outright — capping guesses per delivered SMS at MAX_OTP_ATTEMPTS
 * regardless of how fast an attacker calls. Paired with the per-phone rate limit
 * on sending, that bounds the whole search space rather than just slowing it.
 *
 * @returns {Promise<{ok:true} | {ok:false, message:string}>}
 */
const consumeOtp = async (phone, otp) => {
  if (!phone || !otp) return { ok: false, message: 'Enter the OTP sent to your number.' };

  const record = await Otp.findOne({ phone: String(phone).trim() });
  if (!record) {
    // No code outstanding: never expired, never sent, or already burned. The
    // wording deliberately does not distinguish — that would confirm to an
    // attacker whether a number is in use.
    return { ok: false, message: 'That code has expired. Please request a new one.' };
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await Otp.deleteOne({ _id: record._id });
    return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  // Constant-time compare so the check leaks nothing through timing.
  const a = Buffer.from(String(record.otp));
  const b = Buffer.from(String(otp));
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) {
    const updated = await Otp.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { new: true }
    );
    if (updated && updated.attempts >= MAX_OTP_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
      return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
    }
    const left = MAX_OTP_ATTEMPTS - (updated?.attempts ?? MAX_OTP_ATTEMPTS);
    return { ok: false, message: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }

  await Otp.deleteOne({ _id: record._id });
  return { ok: true };
};

// How long a number must wait between codes. Short enough that someone who
// genuinely missed the SMS isn't stuck, long enough that a stuck retry loop
// can't run up an SMS bill.
const OTP_RESEND_COOLDOWN_SECONDS = 15;

/**
 * Issues a fresh code, replacing any outstanding one for that number.
 *
 * Enforced here rather than in the app: a countdown on a button is a courtesy,
 * not a control — anyone can call the endpoint directly. The server owns the
 * clock and simply reports how long is left, which the app then counts down.
 *
 * Keyed on the number, never the caller's address. Every student on campus
 * shares one WiFi and therefore one public IP, so a per-IP cooldown would mean
 * one person's resend blocking everyone else's sign-in.
 *
 * @returns {Promise<{ok:true, otp:string, retryAfter:number} | {ok:false, retryAfter:number}>}
 */
const issueOtp = async (phone) => {
  const normalized = String(phone).trim();

  const existing = await Otp.findOne({ phone: normalized }).select('createdAt').lean();
  if (existing?.createdAt) {
    const elapsedMs = Date.now() - new Date(existing.createdAt).getTime();
    const remaining = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000);
    if (remaining > 0) return { ok: false, retryAfter: remaining };
  }

  const otp = generateOtp();
  await Otp.deleteMany({ phone: normalized });
  await Otp.create({ phone: normalized, otp, attempts: 0 });
  return { ok: true, otp, retryAfter: OTP_RESEND_COOLDOWN_SECONDS };
};

/**
 * Drops the code for a number. Used when the SMS could not actually be sent —
 * the cooldown shouldn't punish someone for our provider failing.
 */
const discardOtp = (phone) => Otp.deleteMany({ phone: String(phone).trim() });

module.exports = {
  generateOtp,
  consumeOtp,
  issueOtp,
  discardOtp,
  MAX_OTP_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
};
