const crypto = require('crypto');
const Razorpay = require('razorpay');

// One client, shared by the route that opens payments and the one that confirms
// them, so both read the same credentials.
const key_id = process.env.RAZORPAY_KEY_ID;
const key_secret = process.env.RAZORPAY_KEY_SECRET;

const razorpay = new Razorpay({ key_id, key_secret });

const isConfigured = () => Boolean(key_id && key_secret);

/**
 * Recomputes Razorpay's HMAC over order_id|payment_id.
 *
 * This proves the callback really came from Razorpay — nothing more. It says
 * nothing about how much was paid, or what for, which is why confirmation also
 * fetches the payment and checks its amount against the stored draft.
 */
const verifySignature = ({ razorpay_order_id, razorpay_payment_id, razorpay_signature } = {}) => {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  if (!key_secret) return false;

  const expected = crypto
    .createHmac('sha256', key_secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  // Constant-time compare; timingSafeEqual throws unless the lengths match.
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = { razorpay, verifySignature, isConfigured, key_id };
