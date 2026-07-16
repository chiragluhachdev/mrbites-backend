module.exports = [
  {
    name: 'Paneer Butter Masala',
    description: 'Cottage cheese simmered in a rich tomato and cashew gravy.',
    price: 180,
    category: 'Main Course',
    image: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Spice level',
        type: 'single',
        required: true,
        description: 'Kitchen adjusts the chilli, not the gravy.',
        options: [
          { name: 'Mild', priceDiff: 0 },
          { name: 'Medium', priceDiff: 0, isDefault: true },
          { name: 'Spicy', priceDiff: 0 },
        ],
      },
      {
        name: 'Add breads',
        type: 'multi',
        required: false,
        min: 0,
        max: 4,
        options: [
          { name: 'Butter naan', priceDiff: 45 },
          { name: 'Tandoori roti', priceDiff: 25 },
          { name: 'Laccha paratha', priceDiff: 50 },
        ],
      },
    ],
  },
  {
    name: 'Dal Makhani',
    description: 'Black lentils slow cooked overnight with butter and cream.',
    price: 150,
    category: 'Main Course',
    image: 'https://images.unsplash.com/photo-1626500155537-8b8d5b4b45f2?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Portion',
        type: 'single',
        required: true,
        options: [
          { name: 'Half', priceDiff: -40 },
          { name: 'Full', priceDiff: 0, isDefault: true },
        ],
      },
    ],
  },
  {
    name: 'Veg Thali',
    description: 'Two sabzi, dal, rice, four rotis, salad and a sweet.',
    price: 140,
    category: 'Thali',
    image: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Bread',
        type: 'single',
        required: true,
        options: [
          { name: 'Roti', priceDiff: 0, isDefault: true },
          { name: 'Butter roti', priceDiff: 15 },
        ],
      },
      {
        name: 'Extras',
        type: 'multi',
        required: false,
        min: 0,
        max: 3,
        options: [
          { name: 'Extra dal', priceDiff: 30 },
          { name: 'Boondi raita', priceDiff: 35 },
          { name: 'Papad', priceDiff: 15 },
        ],
      },
    ],
  },
  {
    name: 'Paneer Tikka Roll',
    description: 'Tandoori paneer, onions and mint chutney in a warm paratha.',
    price: 110,
    category: 'Rolls',
    image: 'https://images.unsplash.com/photo-1633945274309-2c16c9682a8c?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Make it',
        type: 'single',
        required: false,
        options: [
          { name: 'Regular', priceDiff: 0, isDefault: true },
          { name: 'Double filling', priceDiff: 45 },
        ],
      },
      {
        name: 'Chutney',
        type: 'multi',
        required: false,
        min: 0,
        max: 2,
        options: [
          { name: 'Mint', priceDiff: 0, isDefault: true },
          { name: 'Garlic', priceDiff: 0 },
          { name: 'Extra chutney', priceDiff: 10 },
        ],
      },
    ],
  },
  {
    name: 'Aloo Paratha',
    description: 'Stuffed and griddled, served with curd and pickle.',
    price: 70,
    category: 'Breads',
    image: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Served with',
        type: 'multi',
        required: false,
        min: 0,
        max: 2,
        options: [
          { name: 'Curd', priceDiff: 0, isDefault: true },
          { name: 'White butter', priceDiff: 15 },
        ],
      },
    ],
  },
  {
    name: 'Butter Naan',
    description: 'Fresh from the tandoor, brushed with butter.',
    price: 45,
    category: 'Breads',
    image: 'https://images.unsplash.com/photo-1697155406014-04dc649b0953?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
  {
    name: 'Gulab Jamun',
    description: 'Two pieces, warm sugar syrup.',
    price: 50,
    category: 'Desserts',
    image: 'https://images.unsplash.com/photo-1601303516534-bf0b1a6f5df3?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
];
