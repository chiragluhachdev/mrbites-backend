const express = require('express');
const bcrypt = require('bcrypt');
const Restaurant = require('../models/Restaurant');
const MenuItem = require('../models/MenuItem');
const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const { requireVendor, requireAdmin, ownsOutlet } = require('../middleware/auth');

const router = express.Router();

/**
 * An outlet is orderable only if the platform isn't paused, an admin hasn't
 * closed it, AND the vendor has it open. Three separate switches, each owned by
 * someone different, and the most restrictive wins.
 *
 * Applied on the customer-facing reads only — the vendor's own settings screen
 * still shows its real isOpen flag, so a global pause never silently rewrites
 * what a vendor thinks they configured.
 */
const effectiveIsOpen = (restaurant, orderingEnabled) =>
  Boolean(orderingEnabled) && restaurant.adminClosed !== true && restaurant.isOpen !== false;

// A rating shows only when the global switch AND the outlet's own flag allow it.
const showRating = (restaurant, ratingsEnabled) =>
  ratingsEnabled !== false && restaurant.ratingEnabled !== false;

/** 403s a vendor trying to act on an outlet that isn't theirs. */
const guardOutlet = (req, res, restaurantId) => {
  if (ownsOutlet(req.user, restaurantId)) return true;
  res.status(403).json({ message: 'You can only manage your own outlet' });
  return false;
};

// What each role may write, named explicitly.
//
// This route used to hand req.body straight to findByIdAndUpdate with only
// `rating` stripped, which meant a vendor could grant themselves anything the
// schema had: `posEnabled: true` bypassed the admin's POS gate entirely, and
// `payout.accountNumber` re-pointed their own settlement money with no admin
// involvement or audit trail. An allowlist fails safe — a field added to the
// schema later is unwritable until someone deliberately lists it here.
const VENDOR_WRITABLE = [
  'name', 'location', 'image', 'bannerImage', 'description',
  'isOpen', 'waitTime',
  'contactName', 'contactPhone', 'contactEmail',
];

// Admin-only. `rating`/`ratingEnabled` are the platform's call, not the
// vendor's; `posEnabled` is access the admin grants; `adminClosed` is the
// override a vendor must not be able to undo; payout details route real money.
const ADMIN_ONLY_WRITABLE = [
  'rating', 'ratingEnabled', 'posEnabled', 'adminClosed', 'adminClosedReason',
  'vendorPasskey', 'payout',
];

/**
 * Reduces a request body to the fields this caller is allowed to set.
 * Returns { updates, rejected } — `rejected` is reported back so a vendor
 * hitting an admin-only field is told, rather than silently ignored.
 */
const allowedUpdates = (body = {}, isAdmin) => {
  const allowed = isAdmin ? [...VENDOR_WRITABLE, ...ADMIN_ONLY_WRITABLE] : VENDOR_WRITABLE;
  const updates = {};
  const rejected = [];
  Object.keys(body).forEach((key) => {
    if (allowed.includes(key)) updates[key] = body[key];
    else rejected.push(key);
  });
  return { updates, rejected };
};

// GET /api/restaurants - Get all restaurants
router.get('/', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }

    const [restaurants, settings] = await Promise.all([
      Restaurant.find().sort({ createdAt: -1 }).lean(),
      Settings.get(),
    ]);
    res.json({
      restaurants: restaurants.map((r) => ({
        ...r,
        isOpen: effectiveIsOpen(r, settings.orderingEnabled),
        ratingEnabled: r.ratingEnabled !== false,
        showRating: showRating(r, settings.ratingsEnabled),
      })),
      platform: {
        orderingEnabled: settings.orderingEnabled,
        pausedMessage: settings.pausedMessage,
        ratingsEnabled: settings.ratingsEnabled,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/restaurants/:id - Get single restaurant
router.get('/:id', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }

    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    // Optionally include menu items if requested: ?includeMenu=true
    if (req.query.includeMenu === 'true') {
      const items = await MenuItem.find({ restaurant: restaurant._id, available: true }).lean();
      const map = new Map();
      items.forEach((it) => {
        const cat = it.category || 'Uncategorized';
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat).push({
          id: it._id,
          name: it.name,
          description: it.description,
          price: it.price,
          image: it.image,
          available: it.available,
          modifiers: it.modifiers || [],
          restaurantName: it.restaurantName || restaurant.name,
        });
      });
      const sections = Array.from(map.keys()).map((key) => ({ title: key, data: map.get(key) }));
      return res.json({ restaurant, sections });
    }

    res.json({ restaurant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/restaurants - Create a new outlet — admin only
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, location, image, isOpen, waitTime, description, rating, vendorPasskey } = req.body;

    if (!name || !location || !image) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }

    const restaurantData = {
      name,
      location,
      image,
      isOpen: isOpen !== undefined ? isOpen : true,
      waitTime: waitTime || 0,
      description: description || '',
      rating: rating || 4.5,
    };

    // If admin provided a passkey, hash and store it
    if (vendorPasskey) {
      try {
        restaurantData.vendorPasskey = await bcrypt.hash(String(vendorPasskey), 10);
      } catch (hashErr) {
        console.warn('Vendor passkey hashing failed', hashErr);
      }
    }

    const restaurant = new Restaurant(restaurantData);

    await restaurant.save();
    res.status(201).json({ restaurant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/restaurants/:id - Update restaurant fields — vendor only
router.put('/:id', requireVendor, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected' });
    if (!guardOutlet(req, res, req.params.id)) return;

    const isAdmin = req.user.role === 'admin';
    const { updates, rejected } = allowedUpdates(req.body, isAdmin);

    // Tell a vendor plainly that they reached for something that isn't theirs,
    // rather than accepting the request and quietly dropping the field.
    if (rejected.length) {
      return res.status(403).json({
        message: `Only an admin can change: ${rejected.join(', ')}`,
      });
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    // If admin sent a vendorPasskey, hash it before storing. If an empty value was sent, clear the passkey.
    if (Object.prototype.hasOwnProperty.call(updates, 'vendorPasskey')) {
      if (updates.vendorPasskey) {
        try {
          updates.vendorPasskey = await bcrypt.hash(String(updates.vendorPasskey), 10);
        } catch (hashErr) {
          console.warn('Failed hashing vendorPasskey', hashErr);
          // remove the vendorPasskey field to avoid storing bad value
          delete updates.vendorPasskey;
        }
      } else {
        // explicit clearing
        updates.vendorPasskey = '';
      }
    }

    // Payout is a subdocument: assigning it wholesale would silently blank the
    // fields the caller didn't send — including the account number, which is
    // select:false and so can never be echoed back for a round trip. Flatten it
    // into dot paths so only what was sent is written.
    if (updates.payout && typeof updates.payout === 'object') {
      const { payout, ...rest } = updates;
      Object.entries(payout).forEach(([key, value]) => {
        if (value !== undefined && value !== null) rest[`payout.${key}`] = value;
      });
      Object.assign(updates, rest);
      delete updates.payout;
    }

    const opts = { new: true, runValidators: true };
    const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, updates, opts).lean();
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    // Cascade restaurant name to all menu items when name changes
    if (updates.name) {
      try {
        await MenuItem.updateMany({ restaurant: req.params.id }, { restaurantName: updates.name });
      } catch (cascadeErr) {
        console.warn('Failed cascading restaurant name to menu items', cascadeErr);
      }
    }

    // Broadcast public fields to everyone — customers browsing outlets or sitting
    // on a menu screen see open/close and wait-time changes live. Emitted
    // globally (not to the outlet's room) because those clients aren't in it, and
    // sanitised so a passkey or payout change is never broadcast.
    try {
      const io = req.app.get('io');
      if (io) {
        const PUBLIC = ['name', 'location', 'image', 'bannerImage', 'description', 'isOpen', 'waitTime', 'rating', 'ratingEnabled'];
        const publicUpdates = {};
        PUBLIC.forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(updates, k)) publicUpdates[k] = restaurant[k];
        });
        if (Object.keys(publicUpdates).length) {
          io.emit('restaurant.updated', { id: String(restaurant._id), updates: publicUpdates });
        }
      }
    } catch (emitErr) {
      console.warn('Emit restaurant.updated failed', emitErr);
    }

    res.json({ restaurant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/restaurants/:id/menu - Return menu sections for a restaurant (DB-backed)
router.get('/:id/menu', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    // Fetch menu items for this restaurant
    // Allow vendor to request unavailable items via ?includeUnavailable=true
    const includeUnavailable = req.query.includeUnavailable === 'true';
    const findQuery = { restaurant: restaurant._id };
    if (!includeUnavailable) findQuery.available = true;
    const items = await MenuItem.find(findQuery).lean();

    // Group by category
    const map = new Map();
    items.forEach((it) => {
      const cat = it.category || 'Uncategorized';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push({
        id: it._id,
        name: it.name,
        description: it.description,
        price: it.price,
        image: it.image,
        available: it.available,
        modifiers: it.modifiers || [],
        // Items carry their outlet so anything that outlives the menu screen —
        // a favourite, a cart line — knows where it came from.
        restaurantId: restaurant._id,
        restaurantName: it.restaurantName || restaurant.name,
      });
    });

    const sections = Array.from(map.keys()).map((key) => ({ title: key, data: map.get(key) }));

    const settings = await Settings.get();

    res.json({
      restaurant: {
        id: restaurant._id,
        name: restaurant.name,
        image: restaurant.image,
        // The header crop, or the card image when the vendor hasn't set one.
        banner: restaurant.bannerImage || restaurant.image,
        location: restaurant.location,
        description: restaurant.description,
        // Reads closed while the platform is paused, whatever the outlet set.
        isOpen: effectiveIsOpen(restaurant, settings.orderingEnabled),
        waitTime: restaurant.waitTime,
        rating: restaurant.rating,
        showRating: showRating(restaurant, settings.ratingsEnabled),
      },
      sections,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/restaurants/:id/menu/items - Create a menu item — vendor only
router.post('/:id/menu/items', requireVendor, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected' });
    if (!guardOutlet(req, res, req.params.id)) return;

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    const { name, description, price, image, category, available, modifiers } = req.body;
    if (!name || price === undefined) return res.status(400).json({ message: 'Missing name or price' });

    const item = new MenuItem({
      restaurant: restaurant._id,
      restaurantName: restaurant.name,
      name,
      description: description || '',
      price,
      image: image || '',
      category: category || 'Uncategorized',
      available: available !== undefined ? available : true,
      modifiers: modifiers || [],
    });

    await item.save();
    // Emit menu update to restaurant room if Socket.IO available
    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`restaurant:${restaurant._id}`).emit('menu.updated', { action: 'created', item: { id: item._id, name: item.name, price: item.price, description: item.description, category: item.category } });
      }
    } catch (emitErr) {
      console.warn('Emit menu.created failed', emitErr);
    }

    res.status(201).json({ item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/menu/items/:itemId - Update a menu item — vendor only
router.put('/menu/items/:itemId', requireVendor, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected' });

    // Check ownership from the item's own outlet before touching it.
    const existing = await MenuItem.findById(req.params.itemId).select('restaurant');
    if (!existing) return res.status(404).json({ message: 'Menu item not found' });
    if (!guardOutlet(req, res, existing.restaurant)) return;

    const updates = req.body || {};
    const item = await MenuItem.findByIdAndUpdate(req.params.itemId, updates, { new: true });
    if (!item) return res.status(404).json({ message: 'Menu item not found' });
    // Emit menu update to restaurant room if Socket.IO available
    try {
      const io = req.app.get('io');
      if (io) {
        const rid = item.restaurant || null;
        if (rid) io.to(`restaurant:${rid}`).emit('menu.updated', { action: 'updated', item: { id: item._id, name: item.name, available: item.available } });
        else io.emit('menu.updated', { action: 'updated', item: { id: item._id, name: item.name, available: item.available } });
      }
    } catch (emitErr) {
      console.warn('Emit menu.updated failed', emitErr);
    }
    res.json({ item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/menu/items/:itemId - Remove a menu item — vendor only
router.delete('/menu/items/:itemId', requireVendor, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected' });

    const existing = await MenuItem.findById(req.params.itemId).select('restaurant');
    if (!existing) return res.status(404).json({ message: 'Menu item not found' });
    if (!guardOutlet(req, res, existing.restaurant)) return;

    const item = await MenuItem.findByIdAndDelete(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });
    // Emit menu deletion
    try {
      const io = req.app.get('io');
      if (io) {
        // If item had restaurant ref, use it; otherwise broadcast generically
        const rid = item.restaurant || req.params.restaurantId || null;
        if (rid) io.to(`restaurant:${rid}`).emit('menu.updated', { action: 'deleted', itemId: req.params.itemId });
        else io.emit('menu.updated', { action: 'deleted', itemId: req.params.itemId });
      }
    } catch (emitErr) {
      console.warn('Emit menu.deleted failed', emitErr);
    }

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/restaurants/:id - Delete an outlet and its menu items — admin only
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected' });

    const restaurant = await Restaurant.findByIdAndDelete(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    // Remove associated menu items
    try {
      await MenuItem.deleteMany({ restaurant: restaurant._id });
    } catch (delErr) {
      console.warn('Failed to delete related menu items', delErr);
    }

    // Notify via socket if available
    try {
      const io = req.app.get('io');
      if (io) io.emit('restaurant.deleted', { id: restaurant._id });
    } catch (emitErr) {
      console.warn('Emit restaurant.deleted failed', emitErr);
    }

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
