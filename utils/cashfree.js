const crypto = require('crypto');

// Cashfree Payment Gateway client — the Cashfree counterpart to utils/razorpay.js.
//
// Unlike Razorpay, Cashfree does not hand the app an HMAC to send back. Instead
// the server creates an order (getting a payment_session_id the app hands to the
// Cashfree SDK), and proves the payment by fetching the order's status straight
// from Cashfree afterwards. Confirmation therefore trusts Cashfree's own record,
// never the client — the same principle as the Razorpay amount re-check.

// SANDBOX for testing, PRODUCTION once live. Anything other than PRODUCTION is
// treated as sandbox, so a missing/typo'd value can never accidentally point a
// test build at the live money endpoint.
const isProd = String(process.env.CASHFREE_ENV || '').toUpperCase() === 'PRODUCTION';
const BASE_URL = isProd ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

// Cashfree issues a separate key pair per environment. Pick the pair that
// matches the host we're about to call — using production keys against the
// sandbox host (or vice-versa) is an auth failure. Sandbox falls back to the
// production keys only if no sandbox pair is configured.
const clientId = isProd
  ? process.env.CASHFREE_CLIENT_ID
  : (process.env.SANDBOX_CLIENT_ID || process.env.CASHFREE_CLIENT_ID);
const clientSecret = isProd
  ? process.env.CASHFREE_CLIENT_SECRET
  : (process.env.SANDBOX_CLIENT_SECRET || process.env.CASHFREE_CLIENT_SECRET);

// Pinned to the version the webhook was registered against in the dashboard.
const API_VERSION = '2025-01-01';

const isConfigured = () => Boolean(clientId && clientSecret);

const headers = () => ({
  'Content-Type': 'application/json',
  'x-api-version': API_VERSION,
  'x-client-id': clientId,
  'x-client-secret': clientSecret,
});

/**
 * Opens a Cashfree order for a server-computed amount.
 *
 * @returns {Promise<{ orderId: string, cfOrderId: string, paymentSessionId: string }>}
 * `paymentSessionId` is what the app feeds the Cashfree SDK; `orderId` is our
 * own id, stored on the draft and used to fetch the payment later.
 */
const createOrder = async ({ orderId, amount, customer, notifyUrl }) => {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      order_id: orderId,
      order_amount: Number(amount.toFixed(2)),
      order_currency: 'INR',
      customer_details: {
        // Cashfree requires an alphanumeric id and a phone; name is optional.
        customer_id: String(customer.id),
        customer_phone: String(customer.phone || '0000000000'),
        customer_name: customer.name || 'User',
      },
      order_meta: notifyUrl ? { notify_url: notifyUrl } : undefined,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `Cashfree order create failed (${res.status})`;
    const err = new Error(msg);
    err.cashfree = data;
    throw err;
  }
  return {
    orderId: data.order_id,
    cfOrderId: data.cf_order_id,
    paymentSessionId: data.payment_session_id,
  };
};

/**
 * Fetches an order's authoritative status and amount from Cashfree.
 * order_status is one of ACTIVE | PAID | EXPIRED | TERMINATED | TERMINATION_REQUESTED.
 */
const getOrder = async (orderId) => {
  const res = await fetch(`${BASE_URL}/orders/${encodeURIComponent(orderId)}`, {
    headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `Cashfree order fetch failed (${res.status})`);
    err.cashfree = data;
    throw err;
  }
  return data; // { order_id, order_amount, order_status, ... }
};

/**
 * Verifies a Cashfree webhook. The signature is
 * base64( HMAC-SHA256( clientSecret, timestamp + rawBody ) ), sent in
 * x-webhook-signature with the timestamp in x-webhook-timestamp.
 *
 * `rawBody` MUST be the exact bytes Cashfree sent — the route captures it before
 * JSON parsing, because re-serialising the parsed object would change the bytes
 * and break the signature.
 */
const verifyWebhookSignature = (signature, rawBody, timestamp) => {
  if (!signature || !rawBody || !timestamp || !clientSecret) return false;
  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(String(timestamp) + rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = {
  createOrder,
  getOrder,
  verifyWebhookSignature,
  isConfigured,
  API_VERSION,
  isProd,
};
