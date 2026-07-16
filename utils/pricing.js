// The single source of truth for what an order costs.
//
// MR-Bites charges nobody. Students pay the item total and nothing else — no
// tax, no platform fee, no convenience charge — and vendors keep 100% of what
// their customers pay. There is no commission anywhere in this file by design.
//
// Money still needs tracking because online payments are collected into the
// MR-Bites Razorpay account, which means the platform holds cash that belongs
// to the vendor until an admin settles it. See Order.settlementStatus.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Prices an order from its line items. Item prices already include any
 * modifier deltas the customer selected.
 *
 * `subtotal` and `total` are identical and both equal what the student pays.
 * The vendor is owed exactly this amount.
 */
const priceOrder = (items = []) => {
  const subtotal = round2(
    items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0)
  );
  return { subtotal, total: subtotal };
};

module.exports = { round2, priceOrder };
