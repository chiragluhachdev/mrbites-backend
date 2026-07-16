const mongoose = require('mongoose');

// A snapshot of what the customer picked, not a reference — menu items and
// their prices change, but a placed order must keep reading the way it was
// ordered.
const OrderItemModifierSchema = new mongoose.Schema({
  group: { type: String, required: true },
  name: { type: String, required: true },
  priceDiff: { type: Number, default: 0 },
}, { _id: false });

const OrderItemSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: false },
  name: { type: String, required: true },
  // Unit price including the selected modifiers — the server recomputes the
  // subtotal from price * qty, so modifier costs must already be folded in.
  price: { type: Number, required: true },
  qty: { type: Number, required: true },
  modifiers: { type: [OrderItemModifierSchema], default: [] },
  // Optional per-line instruction (used by the POS: "no onion", etc.).
  note: { type: String },
});

const OrderSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  items: { type: [OrderItemSchema], required: true },
  // What the customer pays. These are equal and carry no fees of any kind —
  // MR-Bites adds nothing on top of the menu price.
  subtotal: { type: Number, required: true },
  total: { type: Number, required: true },

  // The two lanes, kept strictly apart:
  //   ONLINE — placed in the student app, prepaid via Razorpay into the
  //            MR-Bites account, then settled to the vendor by an admin.
  //   POS    — rung up by the vendor at the counter, paid straight to the
  //            vendor (cash/UPI/card/other). The platform never holds this
  //            money, so it carries no settlement obligation.
  source: { type: String, enum: ['ONLINE', 'POS'], default: 'ONLINE' },
  // How a POS sale was paid. Meaningless for ONLINE (always Razorpay).
  posPaymentMethod: { type: String, enum: ['cash', 'upi', 'card', 'other'] },

  pickupType: { type: String, enum: ['DINE_IN', 'PICK_UP'], default: 'DINE_IN' },
  scheduledAt: { type: Date },
  notes: { type: String },
  customer: {
    name: String,
    phone: String,
  },

  // An ONLINE order exists only once its Razorpay signature has verified; a POS
  // order is paid the moment the vendor completes the sale.
  paidAt: { type: Date, required: true },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },

  // Only meaningful for ONLINE. POS orders are created 'settled' with settledAt
  // = paidAt so they never appear as money the platform owes anyone, and admin
  // finance additionally filters to source ONLINE.
  settlementStatus: { type: String, enum: ['pending', 'settled'], default: 'pending' },
  settledAt: { type: Date },

  status: {
    type: String,
    enum: ['pending', 'preparing', 'ready', 'delivered', 'cancelled'],
    default: 'pending',
  },
}, { timestamps: true });

OrderSchema.index({ 'customer.phone': 1 });
OrderSchema.index({ restaurantId: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, status: 1 });
// Finance reads by payment date, and settlements by outlet.
OrderSchema.index({ paidAt: -1 });
OrderSchema.index({ restaurantId: 1, settlementStatus: 1, paidAt: -1 });
// The dashboard and finance split the two lanes constantly.
OrderSchema.index({ restaurantId: 1, source: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
