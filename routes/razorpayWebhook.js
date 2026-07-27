const express = require('express');
const { verifyWebhookSignature } = require('../utils/razorpay');
const OrderDraft = require('../models/OrderDraft');
const PaymentWebhookLog = require('../models/PaymentWebhookLog');
const ordersRouter = require('./orders'); // exposes finalizeDraftToOrders

const router = express.Router();

// POST /api/payments/razorpay/webhook
//
// The Razorpay counterpart to the Cashfree webhook: mounted with express.raw so
// req.body is the exact bytes Razorpay signed. This is the crash-proof path to an
// order — if the app's /confirm call is lost, this still creates it, through the
// same idempotent finaliser (unique index) so the two can't duplicate.
//
// Every hit is logged to PaymentWebhookLog (valid or not, and Razorpay's retries
// as separate rows) so a payment can always be traced.
//
// Handles the events that mean "money captured": payment.captured and order.paid.
router.post('/', async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : (typeof req.body === 'string' ? req.body : '');

  const log = { gateway: 'razorpay', signatureHeader: signature, signatureValid: false };
  const persist = async (extra) => {
    try { await PaymentWebhookLog.create({ ...log, ...extra }); }
    catch (e) { console.warn('PaymentWebhookLog write failed', e?.message); }
  };

  let payload = null;
  try { payload = JSON.parse(rawBody || '{}'); } catch { payload = null; }

  // 1. Authenticity first — Razorpay's documented scheme. On failure, log & refuse.
  const valid = verifyWebhookSignature(rawBody, signature);
  log.signatureValid = valid;
  if (!valid) {
    await persist({ outcome: 'bad_signature', payload: payload || String(rawBody).slice(0, 2000), detail: 'Signature did not match' });
    console.warn('Razorpay webhook: signature verification failed');
    return res.status(401).json({ message: 'Invalid signature' });
  }

  const eventType = payload?.event;
  const payment = payload?.payload?.payment?.entity || {};
  // order.paid carries the order under a separate key; payment.captured carries
  // the order id on the payment itself.
  const orderEntity = payload?.payload?.order?.entity || {};
  const razorpayOrderId = payment.order_id || orderEntity.id;
  const paymentId = payment.id;
  const status = payment.status; // 'captured' | 'authorized' | 'failed' | ...
  const amountPaise = Number(payment.amount);
  Object.assign(log, {
    eventType,
    orderId: razorpayOrderId,
    cfPaymentId: paymentId, // reused column: the gateway payment id
    paymentStatus: status,
    amount: Number.isFinite(amountPaise) ? amountPaise / 100 : undefined,
    payload,
  });

  try {
    // 2. Only a captured payment creates orders. authorized-but-not-captured,
    //    failed, refunded, etc. are logged and acked.
    const isPaid = (eventType === 'payment.captured' || eventType === 'order.paid') && status === 'captured';
    if (!isPaid) {
      await persist({ outcome: 'ignored_not_paid', detail: `event=${eventType} status=${status}` });
      return res.status(200).json({ received: true });
    }
    if (!razorpayOrderId) {
      await persist({ outcome: 'error', detail: 'No order_id in payload' });
      return res.status(200).json({ received: true });
    }

    // 3. Match the stored draft and re-check the amount server-side.
    const draft = await OrderDraft.findOne({ razorpayOrderId });
    if (!draft) {
      await persist({ outcome: 'draft_not_found', detail: `No draft for ${razorpayOrderId}` });
      return res.status(200).json({ received: true });
    }
    if (Math.round(draft.total * 100) !== amountPaise) {
      await persist({ outcome: 'amount_mismatch', detail: `paid=${amountPaise} expected=${Math.round(draft.total * 100)}` });
      console.error('Razorpay webhook amount mismatch', { razorpayOrderId, amountPaise, expected: Math.round(draft.total * 100) });
      return res.status(200).json({ received: true });
    }

    // 4. Create the orders — idempotent, shared with /confirm.
    const io = req.app.get('io');
    const result = await ordersRouter.finalizeDraftToOrders(io, {
      gateway: 'razorpay',
      gatewayOrderId: razorpayOrderId,
      paymentId,
    });

    if (result.conflict) {
      await persist({ outcome: 'error', detail: 'draft claim conflict (confirm in-flight)' });
      return res.status(409).json({ message: 'Processing, please retry' });
    }
    await persist({
      outcome: result.idempotent ? 'idempotent' : 'orders_created',
      detail: `${result.orders?.length || 0} order(s)`,
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    await persist({ outcome: 'error', detail: String(err?.message || err).slice(0, 500) });
    console.error('Razorpay webhook processing failed', { razorpayOrderId, err });
    // 500 → Razorpay retries.
    return res.status(500).json({ message: 'Webhook processing error' });
  }
});

module.exports = router;
