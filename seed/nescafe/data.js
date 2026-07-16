// Outlet record. `vendorPasskey` is plain here and hashed by the seed runner.
module.exports = {
  name: 'Nescafé Corner',
  location: 'Block C, Ground Floor',
  description: 'Coffee, quick bites and cold brews between lectures.',
  image:
    'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1200&q=80',
  isOpen: true,
  waitTime: 8,
  rating: 4.4,
  vendorPasskey: 'nescafe123',
  contactName: 'Ritu Malhotra',
  contactPhone: '9810012345',
  contactEmail: 'nescafe.mru@example.com',
  payout: {
    accountHolder: 'Nescafe Corner',
    accountNumber: '502100449012',
    ifsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    pan: 'ABXPC1234F',
  },
};
