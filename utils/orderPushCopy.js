// Resolves the admin-editable push copy for an order stage.
//
// Templates live on the Settings singleton so the wording can change from the
// admin console without a release. They're cached briefly because a push fires
// on every status change and this would otherwise be an extra read each time;
// the settings route calls invalidate() on save, so an edit still takes effect
// immediately rather than waiting out the TTL.

const Settings = require('../models/Settings');

const TTL_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;

/** Dropped by the settings route the moment templates are saved. */
function invalidate() {
  cached = null;
  cachedAt = 0;
}

async function getTemplates() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const settings = await Settings.get();
  // .toObject() so the sub-document defaults come through as plain values.
  cached = settings.toObject?.().orderNotifications || settings.orderNotifications || {};
  cachedAt = Date.now();
  return cached;
}

// Which template a given status maps to. `ready` splits on pickup type.
function templateKeyFor(status, pickupType) {
  if (status === 'ready') return pickupType === 'DINE_IN' ? 'readyDineIn' : 'readyPickup';
  return status; // pending | preparing | delivered | cancelled
}

const fill = (text, vars) =>
  String(text || '').replace(/\{(\w+)\}/g, (match, key) => (vars[key] != null ? String(vars[key]) : match));

/**
 * The title/body for this order's stage, or null when that stage (or the whole
 * feature) is switched off — in which case no push should be sent at all.
 */
async function resolveOrderPushCopy(order, status) {
  const templates = await getTemplates();
  if (templates.enabled === false) return null;

  const tpl = templates[templateKeyFor(status, order.pickupType)];
  if (!tpl || tpl.enabled === false) return null;
  if (!tpl.title?.trim() || !tpl.body?.trim()) return null;

  const vars = {
    outlet: order.restaurantId?.name || 'the outlet',
    code: `#${String(order._id).slice(-6).toUpperCase()}`,
    amount: `₹${order.total ?? 0}`,
  };
  return { title: fill(tpl.title, vars), body: fill(tpl.body, vars) };
}

module.exports = { resolveOrderPushCopy, invalidate };
