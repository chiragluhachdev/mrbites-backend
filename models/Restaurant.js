const mongoose = require('mongoose');

// Where the admin sends this outlet's settlement money. The full account number
// is never returned by default — the API exposes only the last four digits.
const PayoutSchema = new mongoose.Schema({
  accountHolder: { type: String, default: '' },
  accountNumber: { type: String, default: '', select: false },
  ifsc: { type: String, default: '' },
  bankName: { type: String, default: '' },
  pan: { type: String, default: '' },
}, { _id: false });

const RestaurantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  location: { type: String, required: true },
  // Square-ish crop used on outlet cards and listings.
  image: { type: String, required: true },
  // Wide, short crop for the menu screen header. Falls back to `image` when
  // unset — a card photo stretched into a banner usually crops badly, so
  // vendors can supply one shaped for the space.
  bannerImage: { type: String, default: '' },
  isOpen: { type: Boolean, default: true },
  waitTime: { type: Number, default: 0 }, // in minutes
  description: { type: String, default: '' },
  // Optional vendor passkey for vendor dashboard access (hashed)
  // store hashed passkey and do not return by default
  vendorPasskey: { type: String, default: '', select: false },
  rating: { type: Number, default: 4.5 },
  // Whether this outlet's rating is shown to customers. Admin-controlled per
  // outlet; the global switch in Settings can hide all of them at once.
  ratingEnabled: { type: Boolean, default: true },
  // Admin-granted access to the in-house POS. Off by default — an outlet
  // without it sees the ordinary online-orders dashboard, unchanged.
  posEnabled: { type: Boolean, default: false },

  contactName: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  contactEmail: { type: String, default: '' },
  payout: { type: PayoutSchema, default: () => ({}) },
}, { timestamps: true });

// Virtual to populate menu items (MenuItem collection)
RestaurantSchema.virtual('menu', {
  ref: 'MenuItem',
  localField: '_id',
  foreignField: 'restaurant',
});

// Ensure virtuals are included when converting documents to JSON
RestaurantSchema.set('toObject', { virtuals: true });
RestaurantSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Restaurant', RestaurantSchema);
