// One-time migration for the OTP race fix. Run once, after deploying the new code.
//
//   node scripts/migrate-otp-index.js
//
// The fix relies on a UNIQUE index on Otp.phone (so two concurrent sends can't
// both insert a code) and a 5-minute TTL. The old collection had a non-unique
// index and a 10-minute TTL, and Mongo will not silently change either — this
// resyncs them.
//
// OTPs are ephemeral: every code expires in minutes and is re-requestable. So we
// clear the collection first, which (a) guarantees the unique-index build can't
// trip over a duplicate left by the old schema, and (b) strands nobody — anyone
// mid-login simply taps resend. Nothing of value is lost.

require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — check backend/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected to "${mongoose.connection.name}"`);

  const Otp = require('../models/Otp');

  const { deletedCount } = await Otp.deleteMany({});
  console.log(`cleared ${deletedCount} outstanding OTP(s)`);

  // Drop the old indexes and rebuild from the current schema (unique phone,
  // 5-minute TTL). syncIndexes drops anything not in the schema and creates
  // anything missing.
  await Otp.syncIndexes();

  console.log('OTP indexes now:');
  (await Otp.collection.indexes()).forEach((i) => {
    const tags = [
      i.unique ? 'unique' : null,
      i.expireAfterSeconds !== undefined ? `TTL ${i.expireAfterSeconds}s` : null,
    ].filter(Boolean);
    console.log(`  ${JSON.stringify(i.key)}${tags.length ? '  [' + tags.join(', ') + ']' : ''}`);
  });

  await mongoose.disconnect();
  console.log('done.');
})().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
