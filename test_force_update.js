const jwt = require('jsonwebtoken');
const axios = require('axios');

const JWT_SECRET = '8Kf429LmQx!7PvNz@4RsYhT6Wd$1BcJmXe9UaGp&2LoKi5VnZr3QsHt8FyDwEp';

const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

async function test() {
  try {
    console.log("Fetching current settings...");
    let res = await axios.get('http://localhost:4040/api/settings');
    console.log("Current Settings:", res.data.settings);

    console.log("\nUpdating minAppVersion to 2.0.0...");
    res = await axios.put('http://localhost:4040/api/settings', {
      minAppVersion: '2.0.0',
      updateMessage: 'This is a test update message.'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("Updated Settings:", res.data.settings);

    console.log("\nSetting minAppVersion back to 1.0.0...");
    res = await axios.put('http://localhost:4040/api/settings', {
      minAppVersion: '1.0.0',
      updateMessage: 'Please update MR BITES to the latest version for the best experience.'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("Final Settings:", res.data.settings);
  } catch (err) {
    console.error(err.message, err.response?.data);
  }
}

test();
