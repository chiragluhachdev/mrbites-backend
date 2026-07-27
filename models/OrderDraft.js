const mongoose = require('mongoose');

// A cart, priced by the server, held against the Razorpay order it was quoted
// for. This is what closes the payment loophole: the amount charged and the
// orders eventually created both come from *this* record, so the client cannot
// pay for one cart and receive another.
//
// Lifecycle:
//   awaiting_payment -> consuming -> consumed
//
// `consuming` is a claim: only one request can take a draft from
// awaiting_payment, so two taps on Pay cannot both create orders. Should that
// request die mid-flight the draft is released back to awaiting_payment.

const DraftModifierSchema = new mongoose.Schema({
  group: { type: String, required: true },
  name: { type: String, required: true },
  priceDiff: { type: Number, default: 0 },
}, { _id: false });

const DraftItemSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  qty: { type: Number, required: true },
  // Carried from the live menu by priceCart so the order snapshot keeps the
  // image permanently. Without this field the draft would drop it, and the
  // saved order would have no image — only the live-lookup fallback.
  image: { type: String },
  modifiers: { type: [DraftModifierSchema], default: [] },
}, { _id: false });

const DraftGroupSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  restaurantName: { type: String, default: '' },
  items: { type: [DraftItemSchema], required: true },
  subtotal: { type: Number, required: true },
  total: { type: Number, required: true },
}, { _id: false });

const OrderDraftSchema = new mongoose.Schema({
  // Which gateway this draft was quoted through. The order id below lives in
  // the matching field, and confirmation reads back through the same one.
  gateway: { type: String, enum: ['razorpay', 'cashfree'], default: 'razorpay' },
  // Exactly one of these is set, per `gateway`. Both are optional at the schema
  // level and made unique only when present (partial indexes below), so the two
  // gateways never collide on each other's null.
  razorpayOrderId: { type: String },
  cashfreeOrderId: { type: String },
  // Whose cart this is. Confirmation is refused for anyone else, so a leaked
  // gateway order id cannot be redeemed by another account.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  customer: {
    name: String,
    phone: String,
  },

  // One entry per outlet — a cart may span several, paid for in one go.
  groups: { type: [DraftGroupSchema], required: true },
  // The amount quoted to Razorpay, in rupees. The captured payment is checked
  // against this before any order exists.
  total: { type: Number, required: true },

  pickupType: { type: String, enum: ['DINE_IN', 'PICK_UP'], default: 'DINE_IN' },
  notes: { type: String },

  status: {
    type: String,
    enum: ['awaiting_payment', 'consuming', 'consumed'],
    default: 'awaiting_payment',
  },
  // Set once consumed, so a retried confirmation returns the same orders
  // instead of creating more.
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  razorpayPaymentId: { type: String },
  cashfreePaymentId: { type: String },

  // Unpaid drafts are litter and expire quickly; consumed ones are kept long
  // enough to answer a late retry, then swept.
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// TTL: Mongo removes the document once expiresAt passes.
OrderDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OrderDraftSchema.index({ userId: 1, createdAt: -1 });
// One draft per gateway order id. Partial, so a cashfree draft (no
// razorpayOrderId) and a razorpay draft (no cashfreeOrderId) never collide on
// each other's absent field.
OrderDraftSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } }
);
OrderDraftSchema.index(
  { cashfreeOrderId: 1 },
  { unique: true, partialFilterExpression: { cashfreeOrderId: { $type: 'string' } } }
);

module.exports = mongoose.model('OrderDraft', OrderDraftSchema);
