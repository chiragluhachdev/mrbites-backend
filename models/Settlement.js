const mongoose = require('mongoose');

// An immutable record of one payout from MR-Bites to an outlet.
//
// Settling used to leave no trace beyond a flipped flag on each order: no record
// of who did it, when, for how much, or against which bank transfer. When an
// admin is moving real money by hand, "the orders say settled" is not an audit
// trail — you cannot reconcile it against a bank statement, answer a vendor
// disputing a payout, or notice a double payment after the fact.
//
// Written once, never updated. A mistaken settlement is corrected by recording a
// reversal, not by editing history.

const SettlementSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  restaurantName: { type: String, default: '' },

  // What was actually settled — counted from the orders this settlement really
  // claimed, never from a pre-read snapshot.
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  orderCount: { type: Number, required: true },
  amount: { type: Number, required: true },

  // The IST business day this payout is booked against.
  dayKey: { type: String, required: true, index: true },

  // Free-text bank reference (UTR etc.) so the row can be tied to a statement.
  reference: { type: String, default: '' },
  note: { type: String, default: '' },

  settledAt: { type: Date, required: true },
}, { timestamps: true });

SettlementSchema.index({ restaurantId: 1, settledAt: -1 });

module.exports = mongoose.model('Settlement', SettlementSchema);
