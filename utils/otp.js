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

// The shortest gap between two SMS to the same number. Only stops a double-tap
// or an impatient hammer from firing several texts a second apart; the real
// ceiling on total sends is the per-phone rate limit in server.js.
const OTP_RESEND_COOLDOWN_SECONDS = 15;

/**
 * Gets a code to send to this number.
 *
 * If one is already live, that same code is returned — a resend re-sends what
 * was first issued rather than minting a new one, so the earlier SMS never stops
 * working and the student is never left guessing which code is current. A brand
 * new code is only created when none is outstanding.
 *
 * A short per-number cooldown throttles back-to-back sends (a double-tap), and
 * reports how many seconds remain so the app can count down. It is keyed on the
 * number, never the caller's IP: a campus shares one address, so a per-IP
 * cooldown would let one person's resend block everyone else's sign-in.
 *
 * @returns {Promise<
 *   {ok:true, otp:string, retryAfter:number, reused:boolean} |
 *   {ok:false, retryAfter:number}
 * >}
 */
const issueOtp = async (phone) => {
  const normalized = String(phone).trim();

  const existing = await Otp.findOne({ phone: normalized }).select('otp createdAt').lean();
  if (existing?.otp) {
    const elapsedMs = Date.now() - new Date(existing.createdAt).getTime();
    const remaining = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000);
    if (remaining > 0) return { ok: false, retryAfter: remaining };
    // Past the cooldown: resend the SAME code. createdAt is left untouched, so
    // the ten-minute lifetime still runs from when it was first issued.
    return { ok: true, otp: existing.otp, retryAfter: OTP_RESEND_COOLDOWN_SECONDS, reused: true };
  }

  const otp = generateOtp();
  await Otp.create({ phone: normalized, otp, attempts: 0 });
  return { ok: true, otp, retryAfter: OTP_RESEND_COOLDOWN_SECONDS, reused: false };
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
