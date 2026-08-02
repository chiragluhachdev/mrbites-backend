const mongoose = require('mongoose');

// One editable push template. `{outlet}`, `{code}` and `{amount}` are
// substituted at send time; `enabled: false` silences that stage without
// affecting the others.
const pushTemplate = (title, body) => ({
  enabled: { type: Boolean, default: true },
  title: { type: String, default: title },
  body: { type: String, default: body },
  _id: false,
});

// A single platform-wide settings document. There is only ever one row; it is
// created on first read.
const SettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'platform', unique: true },

  // Master switch. When false, every outlet reads as closed to students —
  // useful for exam weeks, holidays, or a bad day. Individual outlets keep
  // their own isOpen flag underneath, so nothing is lost when it flips back.
  orderingEnabled: { type: Boolean, default: true },
  // Shown to students when ordering is paused.
  pausedMessage: { type: String, default: 'Ordering is paused right now. Please check back later.' },

  // Master switch for outlet ratings. When false, no outlet shows a rating,
  // whatever its own ratingEnabled flag says.
  ratingsEnabled: { type: Boolean, default: true },

  // Which payment gateway the checkout uses, chosen by an admin. Cashfree is
  // the default/first choice; Razorpay is the fallback. The app never decides
  // this — it asks create-order, which reads this setting — so flipping it in
  // the admin dashboard takes effect for the next order without an app update.
  paymentGateway: { type: String, enum: ['cashfree', 'razorpay'], default: 'cashfree' },

  // Demo mode. When on, checkout takes no money: the app shows a confirmation,
  // a marked demo order lands in the customer's history, and nothing reaches
  // Razorpay, the vendor dashboards or the finance figures. Meant for app-store
  // review and staged demos, so reviewers can walk the whole flow without a real
  // card. Off by default; a normal launch never touches it.
  demoMode: { type: Boolean, default: false },

  // Minimum supported app version for Force Update functionality
  minAppVersion: { type: String, default: '1.0.0' },
  
  // Message to display when the user's app is outdated
  updateMessage: { type: String, default: 'Please update MR BITES to the latest version for the best experience.' },

  // The push a customer gets at each stage of their order, editable from the
  // admin console so the wording can change without an app or server release.
  // Defaults reproduce exactly what used to be hardcoded, so an untouched
  // deployment behaves identically.
  //
  // `ready` is split because a dine-in customer and a takeaway customer need
  // different instructions. `cancelled` is one template: only ONLINE orders
  // reach a customer's device in practice, and those always carry a refund.
  orderNotifications: {
    // Master switch for all six — leaves admin broadcasts untouched.
    enabled: { type: Boolean, default: true },
    pending: pushTemplate('Order Confirmed! 🎉', 'Your order from {outlet} has been placed.'),
    preparing: pushTemplate('Order Being Prepared 👨‍🍳', '{outlet} has started preparing your order.'),
    readyDineIn: pushTemplate('Order Ready! ✅', 'Your order from {outlet} is ready — enjoy your meal!'),
    readyPickup: pushTemplate('Order Ready! ✅', 'Your order from {outlet} is ready for pickup.'),
    delivered: pushTemplate('Order Delivered', 'Your order from {outlet} has been delivered. Enjoy!'),
    cancelled: pushTemplate('Order Cancelled', 'Your order from {outlet} was cancelled. Your payment will be refunded within 12 hours.'),
  },
}, { timestamps: true });

/** Reads the singleton, creating it the first time. */
SettingsSchema.statics.get = async function () {
  return (await this.findOne({ key: 'platform' })) || this.create({ key: 'platform' });
};

module.exports = mongoose.model('Settings', SettingsSchema);
