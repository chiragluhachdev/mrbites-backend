const crypto = require('crypto');
const Otp = require('../models/Otp');

const { MAX_OTP_ATTEMPTS, OTP_TTL_SECONDS } = Otp;

// The one place that knows how an OTP is issued and checked.
//
// Three routes consume OTPs — sign-in, changing a number, deleting an account —
// and each used to do its own findOne. Centralising it here means the attempt
// limit, the expiry check and the logging hold whichever route calls in.

// How long a code lives, and the shortest gap between two texts to one number.
// Expiry comes from the model so the code and its TTL index can never disagree.
const OTP_EXPIRY_MS = OTP_TTL_SECONDS * 1000;
const OTP_RESEND_COOLDOWN_SECONDS = 30;
const OTP_RESEND_COOLDOWN_MS = OTP_RESEND_COOLDOWN_SECONDS * 1000;

// Never log a full number. Last four is enough to correlate events for one user
// while keeping the log from becoming a directory of who signed in when.
const mask = (phone) => {
  const p = String(phone || '');
  return p.length >= 4 ? `••••••${p.slice(-4)}` : '••••';
};
const log = (event, phone, extra = '') =>
  console.log(`[otp] ${event} phone=${mask(phone)}${extra ? ' ' + extra : ''}`);

/** A six-digit code. crypto rather than Math.random: this is a credential. */
const generateOtp = () => String(crypto.randomInt(100000, 1000000));

/**
 * Gets a code to send to this number, race-free.
 *
 * The guarantee is: one number has at most one live code at a time, and a resend
 * re-sends that same code rather than minting a new one. So a slow first SMS and
 * a resend can never leave the user holding two different codes where only the
 * newer verifies — the classic "I got the OTP but it says invalid" bug.
 *
 * Ordering matters:
 *   1. Clear an expired code first, so step 2 can't reuse a stale one.
 *   2. Atomically claim a resend — findOneAndUpdate is one op, so when two
 *      resends race only one bumps lastSentAt and re-sends; the other is told to
 *      wait. Reuse never changes the digits, so even a rare double-send is safe.
 *   3. If nothing was claimed, either a code exists but is cooling down (wait),
 *      or none exists (mint one). The unique index closes the create race — a
 *      losing concurrent create throws duplicate-key and falls back to reuse.
 *
 * @returns {Promise<
 *   {ok:true, otp:string, retryAfter:number, reused:boolean, sentAt:Date} |
 *   {ok:false, retryAfter:number}
 * >}
 */
const issueOtp = async (phone) => {
  const normalized = String(phone).trim();
  const now = Date.now();
  const cooldownCutoff = new Date(now - OTP_RESEND_COOLDOWN_MS);
  const expiryCutoff = new Date(now - OTP_EXPIRY_MS);

  // 1. Drop an expired code up front. The TTL index also sweeps these, but only
  //    about once a minute — this makes the five-minute boundary exact and stops
  //    a just-expired code being reused below.
  const swept = await Otp.deleteOne({ phone: normalized, createdAt: { $lte: expiryCutoff } });
  if (swept.deletedCount) log('expired-cleared', normalized);

  // 2. Atomic resend claim: reuse the same code, but only past the cooldown.
  const claimed = await Otp.findOneAndUpdate(
    { phone: normalized, lastSentAt: { $lte: cooldownCutoff } },
    { $set: { lastSentAt: new Date(now) } },
    { new: true }
  );
  if (claimed) {
    log('reuse', normalized);
    return { ok: true, otp: claimed.otp, retryAfter: OTP_RESEND_COOLDOWN_SECONDS, reused: true, sentAt: claimed.lastSentAt };
  }

  // 3a. A code exists but is still cooling down — report the wait.
  const existing = await Otp.findOne({ phone: normalized }).select('lastSentAt').lean();
  if (existing) {
    const remaining = Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - existing.lastSentAt.getTime())) / 1000));
    log('cooldown', normalized, `retryAfter=${remaining}s`);
    return { ok: false, retryAfter: remaining };
  }

  // 3b. Nothing outstanding — mint a fresh code.
  const otp = generateOtp();
  const sentAt = new Date(now);
  try {
    await Otp.create({ phone: normalized, otp, attempts: 0, lastSentAt: sentAt, createdAt: sentAt });
    log('create', normalized);
    return { ok: true, otp, retryAfter: OTP_RESEND_COOLDOWN_SECONDS, reused: false, sentAt };
  } catch (err) {
    // The unique index fired: a concurrent request created it a moment ago.
    // Treat that as "reuse theirs", honouring the cooldown.
    if (err && err.code === 11000) {
      const e = await Otp.findOne({ phone: normalized });
      if (e) {
        const remaining = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - e.lastSentAt.getTime())) / 1000);
        if (remaining > 0) {
          log('cooldown', normalized, `retryAfter=${remaining}s (raced)`);
          return { ok: false, retryAfter: Math.max(1, remaining) };
        }
        log('reuse', normalized, '(raced)');
        return { ok: true, otp: e.otp, retryAfter: OTP_RESEND_COOLDOWN_SECONDS, reused: true, sentAt: e.lastSentAt };
      }
    }
    throw err;
  }
};

/**
 * Removes a code we tried to send but couldn't — but ONLY if it hasn't been
 * re-sent since. Pass the `sentAt` from issueOtp: a delayed failure of an old
 * send then matches nothing (a later resend bumped lastSentAt) and cannot delete
 * a code that resend already delivered. With no `sentAt` it clears unconditionally.
 */
const discardOtp = (phone, sentAt) => {
  const query = { phone: String(phone).trim() };
  if (sentAt) query.lastSentAt = sentAt;
  return Otp.deleteOne(query);
};

/**
 * Consumes an OTP.
 *
 * Correct → deleted immediately (no replay). Wrong → attempt counter climbs and,
 * at the ceiling, the code is burned. Expired-but-not-yet-swept is rejected
 * explicitly, since the TTL sweep is only periodic.
 *
 * @returns {Promise<{ok:true} | {ok:false, message:string}>}
 */
const consumeOtp = async (phone, otp) => {
  const normalized = String(phone || '').trim();
  if (!normalized || !otp) return { ok: false, message: 'Enter the OTP sent to your number.' };

  const record = await Otp.findOne({ phone: normalized });
  if (!record) {
    // No code outstanding — never sent, expired, or already burned. The wording
    // does not distinguish: that would confirm whether a number is in use.
    log('verify-miss', normalized);
    return { ok: false, message: 'That code has expired. Please request a new one.' };
  }

  // Explicit expiry — the TTL sweep runs about once a minute, so a code can
  // linger a little past its five minutes. Never accept one that has.
  if (Date.now() - record.createdAt.getTime() >= OTP_EXPIRY_MS) {
    await Otp.deleteOne({ _id: record._id });
    log('verify-expired', normalized);
    return { ok: false, message: 'That code has expired. Please request a new one.' };
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await Otp.deleteOne({ _id: record._id });
    log('verify-locked', normalized);
    return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  // Constant-time compare so the check leaks nothing through timing.
  const a = Buffer.from(String(record.otp));
  const b = Buffer.from(String(otp));
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) {
    const updated = await Otp.findOneAndUpdate({ _id: record._id }, { $inc: { attempts: 1 } }, { new: true });
    if (updated && updated.attempts >= MAX_OTP_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
      log('verify-locked', normalized);
      return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
    }
    const left = MAX_OTP_ATTEMPTS - (updated?.attempts ?? MAX_OTP_ATTEMPTS);
    log('verify-wrong', normalized, `left=${left}`);
    return { ok: false, message: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }

  await Otp.deleteOne({ _id: record._id });
  log('verify-ok', normalized);
  return { ok: true };
};

/** Issues a fresh code, replacing any outstanding one for that number. */
module.exports = {
  generateOtp,
  consumeOtp,
  issueOtp,
  discardOtp,
  MAX_OTP_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_EXPIRY_MS,
};
