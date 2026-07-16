/**
 * Seeds the outlets and their menus.
 *
 *   node seed              # add outlets that don't exist yet, leave the rest
 *   node seed --reset      # delete ALL restaurants and menu items, then reseed
 *
 * Each outlet lives in its own folder here:
 *   seed/<outlet>/data.js  -> the restaurant record (passkey in plain text)
 *   seed/<outlet>/menu.js  -> its menu items, with modifier groups
 *
 * Orders and users are never touched, in either mode.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const Restaurant = require('../models/Restaurant');
const MenuItem = require('../models/MenuItem');

const RESET = process.argv.includes('--reset');

// Every subdirectory here is one outlet.
const outletDirs = fs
  .readdirSync(__dirname, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const loadOutlet = (dir) => ({
  dir,
  data: require(path.join(__dirname, dir, 'data.js')),
  menu: require(path.join(__dirname, dir, 'menu.js')),
});

const seedOutlet = async ({ dir, data, menu }) => {
  const { vendorPasskey, ...fields } = data;

  const existing = await Restaurant.findOne({ name: fields.name });
  if (existing && !RESET) {
    console.log(`  · ${fields.name} — already exists, skipped`);
    return { skipped: true };
  }

  const restaurant = await Restaurant.create({
    ...fields,
    // Stored hashed; the plain value in data.js is only for you to log in with.
    vendorPasskey: vendorPasskey ? await bcrypt.hash(String(vendorPasskey), 10) : '',
  });

  await MenuItem.insertMany(
    menu.map((item) => ({
      ...item,
      restaurant: restaurant._id,
      restaurantName: restaurant.name,
      available: item.available !== false,
    }))
  );

  const groups = menu.reduce((n, i) => n + (i.modifiers?.length || 0), 0);
  console.log(
    `  ✓ ${fields.name}  (${dir})\n` +
      `      id       ${restaurant._id}\n` +
      `      passkey  ${vendorPasskey}\n` +
      `      items    ${menu.length}, ${groups} option group(s)`
  );
  return { skipped: false };
};

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — check backend/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\nConnected to "${mongoose.connection.name}"`);

  if (RESET) {
    const [r, m] = await Promise.all([Restaurant.countDocuments(), MenuItem.countDocuments()]);
    console.log(`--reset: deleting ${r} restaurant(s) and ${m} menu item(s)\n`);
    await Promise.all([Restaurant.deleteMany({}), MenuItem.deleteMany({})]);
  } else {
    console.log('');
  }

  const outlets = outletDirs.map(loadOutlet);
  for (const outlet of outlets) await seedOutlet(outlet);

  const [restaurants, items] = await Promise.all([
    Restaurant.countDocuments(),
    MenuItem.countDocuments(),
  ]);
  console.log(`\nDone. ${restaurants} outlet(s), ${items} menu item(s) in the database.`);
  if (!RESET) console.log('Run with --reset to wipe and reseed from scratch.');

  await mongoose.disconnect();
})().catch((err) => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
