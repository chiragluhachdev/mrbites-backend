module.exports = [
  {
    name: 'Kulhad Masala Chai',
    description: 'Brewed with ginger, cardamom and clove. Served in clay.',
    price: 30,
    category: 'Chai',
    image: 'https://images.unsplash.com/photo-1597481499750-3e6b22637e12?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Strength',
        type: 'single',
        required: false,
        options: [
          { name: 'Regular', priceDiff: 0, isDefault: true },
          { name: 'Kadak', priceDiff: 5 },
        ],
      },
      {
        name: 'Sugar',
        type: 'single',
        required: false,
        options: [
          { name: 'Normal', priceDiff: 0, isDefault: true },
          { name: 'Less', priceDiff: 0 },
          { name: 'None', priceDiff: 0 },
        ],
      },
    ],
  },
  {
    name: 'Ginger Lemon Tea',
    description: 'No milk, sharp ginger, fresh lemon.',
    price: 35,
    category: 'Chai',
    image: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
  {
    name: 'Masala Maggi',
    description: 'Two minute noodles, done the tapri way.',
    price: 60,
    category: 'Maggi',
    image: 'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Make it',
        type: 'single',
        required: true,
        options: [
          { name: 'Plain masala', priceDiff: 0, isDefault: true },
          { name: 'Veg loaded', priceDiff: 25 },
          { name: 'Cheese', priceDiff: 30 },
        ],
      },
      {
        name: 'Toppings',
        type: 'multi',
        required: false,
        min: 0,
        max: 3,
        options: [
          { name: 'Extra cheese', priceDiff: 25 },
          { name: 'Butter', priceDiff: 10 },
          { name: 'Green chilli', priceDiff: 0 },
          { name: 'Peri peri', priceDiff: 5 },
        ],
      },
    ],
  },
  {
    name: 'Samosa',
    description: 'Two pieces with imli and mint chutney.',
    price: 30,
    category: 'Snacks',
    image: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Chutney',
        type: 'multi',
        required: false,
        min: 0,
        max: 2,
        options: [
          { name: 'Imli', priceDiff: 0, isDefault: true },
          { name: 'Mint', priceDiff: 0, isDefault: true },
        ],
      },
    ],
  },
  {
    name: 'Bread Pakora',
    description: 'Potato stuffed, deep fried, served hot.',
    price: 40,
    category: 'Snacks',
    image: 'https://images.unsplash.com/photo-1626132647523-66f5bf380027?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
  {
    name: 'Bun Maska',
    description: 'Soft bun, thick butter. Best with kadak chai.',
    price: 35,
    category: 'Snacks',
    image: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
];
