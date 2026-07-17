// The single authority on what a cart costs and whether it may be ordered.
//
// Everything here is derived from the database. The client sends only *what* it
// wants — item ids, quantities, and the names of the options picked — never a
// price, a name, or even which outlet an item belongs to. That is deliberate:
// the previous flow priced orders from client-supplied `price` fields, which
// meant anyone could order a ₹500 meal for ₹1 simply by editing the request.
//
// Used by the payment route before a Razorpay order is created, so a cart that
// fails here never reaches the payment sheet and the customer is never charged.

const MenuItem = require('../models/MenuItem');
const Restaurant = require('../models/Restaurant');
const Settings = require('../models/Settings');
const { priceOrder, round2 } = require('./pricing');

// One line may not exceed this. Guards against a fat-fingered or hostile qty
// turning into a five-figure order.
const MAX_QTY_PER_LINE = 50;

const fail = (reason, message) => ({ ok: false, reason, message });

/**
 * Resolves the options a customer picked against the item's live modifier
 * groups, returning DB-sourced price deltas — never the client's.
 *
 * Returns { ok, modifiers, delta } or { ok:false, message }.
 */
const resolveModifiers = (item, sent = []) => {
  const groups = (item.modifiers || []).filter((g) => g.active !== false);
  const chosen = Array.isArray(sent) ? sent : [];

  const modifiers = [];
  let delta = 0;

  // Every option the client named must still exist, still be active, and still
  // be in stock. A vendor retiring an option mid-session invalidates the cart
  // rather than silently charging the old price.
  for (const pick of chosen) {
    const group = groups.find((g) => g.name === pick?.group);
    if (!group) {
      return { ok: false, message: `“${item.name}” has changed since you added it. Please add it again.` };
    }
    const option = (group.options || []).find((o) => o.name === pick?.name);
    if (!option) {
      return { ok: false, message: `“${item.name}” has changed since you added it. Please add it again.` };
    }
    if (option.available === false) {
      return { ok: false, message: `“${option.name}” for ${item.name} is sold out.` };
    }
    const priceDiff = Number(option.priceDiff) || 0;
    modifiers.push({ group: group.name, name: option.name, priceDiff });
    delta += priceDiff;
  }

  // The group's own rules are enforced here too — a crafted request must not be
  // able to skip a required choice or exceed a maximum.
  for (const group of groups) {
    const count = modifiers.filter((m) => m.group === group.name).length;
    if (group.type === 'single') {
      if (count > 1) {
        return { ok: false, message: `Choose only one ${group.name} for ${item.name}.` };
      }
      if (group.required && count !== 1) {
        return { ok: false, message: `Choose a ${group.name} for ${item.name}.` };
      }
    } else {
      const min = Number(group.min) || 0;
      const max = Number(group.max) || 0;
      if (count < min) {
        return { ok: false, message: `Choose at least ${min} ${group.name} for ${item.name}.` };
      }
      if (max > 0 && count > max) {
        return { ok: false, message: `Choose at most ${max} ${group.name} for ${item.name}.` };
      }
    }
  }

  return { ok: true, modifiers, delta };
};

/**
 * Validates and prices a cart.
 *
 * @param {Array} lines - [{ itemId, qty, modifiers: [{ group, name }] }]
 * @returns {Promise<{ok:true, groups:Array, total:number} | {ok:false, reason:string, message:string}>}
 *
 * `groups` is one entry per outlet — a cart may span several — each already
 * priced and shaped exactly like an Order's items, ready to persist.
 */
const priceCart = async (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail('empty_cart', 'Your cart is empty.');
  }

  // The platform-wide pause outranks everything else.
  const settings = await Settings.get();
  if (!settings.orderingEnabled) {
    return fail('platform_paused', settings.pausedMessage || 'Ordering is paused right now. Please try again later.');
  }

  for (const line of lines) {
    const qty = Number(line?.qty);
    if (!line?.itemId || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return fail('bad_request', 'Your cart could not be read. Please rebuild it and try again.');
    }
  }

  const itemIds = [...new Set(lines.map((l) => String(l.itemId)))];
  let items;
  try {
    items = await MenuItem.find({ _id: { $in: itemIds } }).lean();
  } catch {
    // A malformed id reaches Mongo as a cast error — treat as a stale cart.
    return fail('item_unavailable', 'Something in your cart is no longer available. Please rebuild it.');
  }
  const itemById = new Map(items.map((i) => [String(i._id), i]));

  // Which outlets does this cart actually touch? Derived from the items
  // themselves, never from the client — so an item cannot be attributed to an
  // outlet it does not belong to.
  const restaurantIds = [...new Set(items.map((i) => String(i.restaurant)))];
  const restaurants = await Restaurant.find({ _id: { $in: restaurantIds } })
    .select('name isOpen adminClosed')
    .lean();
  const restaurantById = new Map(restaurants.map((r) => [String(r._id), r]));

  const byOutlet = new Map();

  for (const line of lines) {
    const item = itemById.get(String(line.itemId));
    if (!item) {
      return fail('item_unavailable', 'Something in your cart is no longer on the menu. Please remove it and try again.');
    }
    if (item.available === false) {
      return fail('item_unavailable', `“${item.name}” is sold out right now. Please remove it to continue.`);
    }

    const outlet = restaurantById.get(String(item.restaurant));
    if (!outlet) {
      return fail('item_unavailable', 'Something in your cart is no longer available. Please rebuild it.');
    }
    // Both switches, same as the customer-facing listing: a vendor closing up,
    // or an admin closing them, each stops the order.
    if (outlet.isOpen === false || outlet.adminClosed === true) {
      return fail('outlet_closed', `${outlet.name} just closed and can't take orders right now. Remove its items to continue.`);
    }

    const resolved = resolveModifiers(item, line.modifiers);
    if (!resolved.ok) return fail('item_changed', resolved.message);

    const unitPrice = round2((Number(item.price) || 0) + resolved.delta);
    if (unitPrice < 0) {
      return fail('bad_request', 'That combination cannot be priced. Please rebuild your cart.');
    }

    const rid = String(item.restaurant);
    if (!byOutlet.has(rid)) {
      byOutlet.set(rid, { restaurantId: rid, restaurantName: outlet.name, items: [] });
    }
    byOutlet.get(rid).items.push({
      itemId: item._id,
      name: item.name, // authoritative — the client's label is ignored
      price: unitPrice,
      qty: Number(line.qty),
      modifiers: resolved.modifiers,
    });
  }

  const groups = [...byOutlet.values()].map((g) => {
    const { subtotal, total } = priceOrder(g.items);
    return { ...g, subtotal, total };
  });

  const total = round2(groups.reduce((s, g) => s + g.total, 0));
  if (total <= 0) {
    return fail('bad_request', 'That order totals nothing. Please rebuild your cart.');
  }

  return { ok: true, groups, total };
};

module.exports = { priceCart, MAX_QTY_PER_LINE };
