// One-time migration to make the payment indexes gateway-agnostic.
//
// Before Cashfree, OrderDraft.razorpayOrderId carried a plain `unique` index
// (non-partial). A Cashfree draft has no razorpayOrderId, so the *second* such
// draft would collide with the first on a null value under that old index. This
// converts it to a partial unique index (only enforced when the field is a
// string), and adds the matching Cashfree indexes on both collections.
//
// Safe to run more than once: it only drops the old non-partial index if it's
// still there, and createIndex is a no-op when the index already matches.
//
// Usage:  node scripts/migrate-payment-indexes.js

require('dotenv').config();
const mongoose = require('mongoose');

const listIndexes = async (col, label) => {
  const ix = await col.indexes();
  console.log(`\n${label} indexes:`);
  ix.forEach((i) => {
    const flags = [i.unique ? 'unique' : '', i.partialFilterExpression ? 'partial' : ''].filter(Boolean).join(',');
    console.log(`  ${i.name}  ${JSON.stringify(i.key)}${flags ? '  [' + flags + ']' : ''}`);
  });
};

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — check backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected to "${mongoose.connection.name}"`);

  const db = mongoose.connection.db;
  const drafts = db.collection('orderdrafts');
  const orders = db.collection('orders');

  await listIndexes(drafts, 'orderdrafts (before)');

  // 1. Drop any old, non-partial single-field unique index on razorpayOrderId.
  const draftIx = await drafts.indexes();
  for (const i of draftIx) {
    const keys = Object.keys(i.key || {});
    if (keys.length === 1 && keys[0] === 'razorpayOrderId' && !i.partialFilterExpression) {
      console.log(`\nDropping old non-partial index orderdrafts.${i.name}`);
      await drafts.dropIndex(i.name);
    }
  }

  // 2. Recreate the draft indexes as partial unique (default names match the
  //    Mongoose schema, so the app's autoIndex sees them as already-present).
  console.log('Creating partial unique indexes on orderdrafts…');
  await drafts.createIndex(
    { razorpayOrderId: 1 },
    { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } }
  );
  await drafts.createIndex(
    { cashfreeOrderId: 1 },
    { unique: true, partialFilterExpression: { cashfreeOrderId: { $type: 'string' } } }
  );

  // 3. Add the Cashfree (order, outlet) uniqueness guard on orders. The Razorpay
  //    equivalent was already partial, so it needs no change.
  console.log('Creating partial unique index on orders (cashfreeOrderId, restaurantId)…');
  await orders.createIndex(
    { cashfreeOrderId: 1, restaurantId: 1 },
    { unique: true, partialFilterExpression: { cashfreeOrderId: { $type: 'string' } } }
  );

  await listIndexes(drafts, 'orderdrafts (after)');
  await listIndexes(orders, 'orders (after)');

  await mongoose.disconnect();
  console.log('\nMigration complete ✓');
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
