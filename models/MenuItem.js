const mongoose = require('mongoose');

// Groups and options keep their _id: the cart derives a line key from the
// selected option ids, so those ids must be stable across reads.
const ModifierOptionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  priceDiff: { type: Number, default: 0 },
  // Preselected when the customization sheet opens.
  isDefault: { type: Boolean, default: false },
  // Sold out today — shown but not selectable.
  available: { type: Boolean, default: true },
});

const ModifierGroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  // 'single' renders radios and permits one pick; 'multi' renders checkboxes
  // and honours min/max.
  type: { type: String, enum: ['single', 'multi'], default: 'single' },
  required: { type: Boolean, default: false },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  // Lets a vendor retire a group without deleting it from past orders.
  active: { type: Boolean, default: true },
  options: [ModifierOptionSchema],
});

const MenuItemSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  // denormalized restaurant name for easier client display
  restaurantName: { type: String, required: false },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true },
  image: { type: String },
  category: { type: String, default: 'Uncategorized' },
  available: { type: Boolean, default: true },
  modifiers: [ModifierGroupSchema],
}, { timestamps: true });

// Every menu load queries items by their outlet, often filtered to available —
// the busiest read in the app, so index it.
MenuItemSchema.index({ restaurant: 1, available: 1 });

module.exports = mongoose.model('MenuItem', MenuItemSchema);
