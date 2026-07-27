const express = require('express');
const cashfree = require('../utils/cashfree');
const OrderDraft = require('../models/OrderDraft');
const PaymentWebhookLog = require('../models/PaymentWebhookLog');
const ordersRouter = require('./orders'); // exposes finalizeDraftToOrders

const router = express.Router();

// POST /api/payments/cashfree/webhook
//
// Mounted with express.raw (see server.js), so req.body is the exact bytes
// Cashfree sent — re-serialising a parsed object would change them and break the
// signature. This is the reliable path to an order: even if the app's /confirm
// call is lost, this fires and creates the order, using the same idempotent
// finaliser so the two can't produce duplicates.
//
// Every hit is written to PaymentWebhookLog — valid or not, success or not, and
// Cashfree's automatic retries as separate rows — so a payment can always be
// traced after the fact.
router.post('/', async (req, res) => {
  const signature = req.get('x-webhook-signature');
  const timestamp = req.get('x-webhook-timestamp');
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : (typeof req.body === 'string' ? req.body : '');

  const log = {
    gateway: 'cashfree',
    signatureHeader: signature,
    timestampHeader: timestamp,
    signatureValid: false,
  };
  // Never let a logging failure change the webhook's response.
  const persist = async (extra) => {
    try { await PaymentWebhookLog.create({ ...log, ...extra }); }
    catch (e) { console.warn('PaymentWebhookLog write failed', e?.message); }
  };

  let payload = null;
  try { payload = JSON.parse(rawBody || '{}'); } catch { payload = null; }

  // 1. Authenticity first — Cashfree's official scheme. On failure, log & refuse.
  const valid = cashfree.verifyWebhookSignature(signature, rawBody, timestamp);
  log.signatureValid = valid;
  if (!valid) {
    await persist({ outcome: 'bad_signature', payload: payload || String(rawBody).slice(0, 2000), detail: 'Signature did not match' });
    console.warn('Cashfree webhook: signature verification failed');
    return res.status(401).json({ message: 'Invalid signature' });
  }

  const eventType = payload?.type;
  const order = payload?.data?.order || {};
  const payment = payload?.data?.payment || {};
  const orderId = order.order_id;
  const amount = Number(order.order_amount);
  const paymentStatus = payment.payment_status;
  const cfPaymentId = payment.cf_payment_id != null ? String(payment.cf_payment_id) : undefined;
  Object.assign(log, { eventType, orderId, amount, paymentStatus, cfPaymentId, payload });

  try {
    // 2. Only a successful payment creates orders. Failed / user-dropped events
    //    are logged for the record and acked.
    const isSuccess = eventType === 'PAYMENT_SUCCESS_WEBHOOK' || paymentStatus === 'SUCCESS';
    if (!isSuccess) {
      await persist({ outcome: 'ignored_not_paid', detail: `event=${eventType} status=${paymentStatus}` });
      return res.status(200).json({ received: true });
    }
    if (!orderId) {
      await persist({ outcome: 'error', detail: 'No order_id in payload' });
      return res.status(200).json({ received: true });
    }

    // 3. Match the stored draft and re-check the amount server-side — never
    //    trust the webhook's number over what we quoted.
    const draft = await OrderDraft.findOne({ cashfreeOrderId: orderId });
    if (!draft) {
      // Acking (200) stops pointless retries for something we can't resolve.
      await persist({ outcome: 'draft_not_found', detail: `No draft for ${orderId}` });
      return res.status(200).json({ received: true });
    }
    if (Math.round(amount * 100) !== Math.round(draft.total * 100)) {
      await persist({ outcome: 'amount_mismatch', detail: `paid=${amount} expected=${draft.total}` });
      console.error('Cashfree webhook amount mismatch', { orderId, amount, expected: draft.total });
      return res.status(200).json({ received: true });
    }

    // 4. Create the orders — idempotent, shared with /confirm.
    const io = req.app.get('io');
    const result = await ordersRouter.finalizeDraftToOrders(io, {
      gateway: 'cashfree',
      gatewayOrderId: orderId,
      paymentId: cfPaymentId || null,
    });

    if (result.conflict) {
      // The app's /confirm is finishing it this instant. Ask Cashfree to retry
      // so the order still records if that call somehow dies.
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
    console.error('Cashfree webhook processing failed', { orderId, err });
    // 500 → Cashfree retries per the configured policy (2, 10, 30 min).
    return res.status(500).json({ message: 'Webhook processing error' });
  }
});

module.exports = router;
