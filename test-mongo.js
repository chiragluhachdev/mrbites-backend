require('dotenv').config();
const mongoose = require('mongoose');
const Otp = require('./models/Otp');
const User = require('./models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const otps = await Otp.find({});
  console.log('OTPs:', otps);
  const users = await User.find({});
  console.log('Users:', users);
  mongoose.disconnect();
}
run();
