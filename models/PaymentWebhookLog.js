const mongoose = require('mongoose');

// An audit trail of every payment webhook the backend receives — one row per
// HTTP hit, so Cashfree's automatic retries show up as separate rows against the
// same order. This is deliberately written for *every* call, including ones with
// a bad signature or an unknown order, because those are exactly the cases you
// need to see when a payment "didn't go through" and you're debugging weeks later.
const PaymentWebhookLogSchema = new mongoose.Schema({
  gateway: { type: String, enum: ['cashfree', 'razorpay'], default: 'cashfree' },

  // The event Cashfree says this is: PAYMENT_SUCCESS_WEBHOOK,
  // PAYMENT_FAILED_WEBHOOK, PAYMENT_USER_DROPPED_WEBHOOK, etc.
  eventType: { type: String },
  orderId: { type: String, index: true },      // gateway order id
  cfPaymentId: { type: String },
  paymentStatus: { type: String },              // SUCCESS | FAILED | USER_DROPPED | ...
  amount: { type: Number },

  // Did the signature verify? A false here on a real Cashfree call means a
  // secret mismatch or a tampered request — the first thing to check.
  signatureValid: { type: Boolean, default: false },

  // What the handler did with it, for at-a-glance debugging:
  //   bad_signature | orders_created | idempotent | ignored_not_paid |
  //   draft_not_found | amount_mismatch | error
  outcome: { type: String },
  detail: { type: String },

  // The raw headers and parsed body, kept verbatim so a failed verification can
  // be reproduced by hand.
  signatureHeader: { type: String },
  timestampHeader: { type: String },
  payload: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

// Keep three months of history, then let Mongo sweep it — enough to investigate
// any dispute, without growing without bound.
PaymentWebhookLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('PaymentWebhookLog', PaymentWebhookLogSchema);
