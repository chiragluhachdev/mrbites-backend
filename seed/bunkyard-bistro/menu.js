module.exports = [
  {
    name: 'Classic Veg Burger',
    description: 'Crumbed patty, lettuce, tomato and house mayo in a toasted bun.',
    price: 90,
    category: 'Burgers',
    image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Patty',
        type: 'single',
        required: true,
        options: [
          { name: 'Aloo tikki', priceDiff: 0, isDefault: true },
          { name: 'Paneer', priceDiff: 30 },
          { name: 'Corn & spinach', priceDiff: 20 },
        ],
      },
      {
        name: 'Make it a combo',
        type: 'single',
        required: false,
        description: 'Adds fries and a soft drink.',
        options: [
          { name: 'No combo', priceDiff: 0, isDefault: true },
          { name: 'Add fries + drink', priceDiff: 70 },
        ],
      },
      {
        name: 'Extras',
        type: 'multi',
        required: false,
        min: 0,
        max: 3,
        options: [
          { name: 'Cheese slice', priceDiff: 20 },
          { name: 'Extra patty', priceDiff: 45 },
          { name: 'Jalapeños', priceDiff: 15 },
        ],
      },
    ],
  },
  {
    name: 'Peri Peri Fries',
    description: 'Crisp fries tossed in peri peri seasoning.',
    price: 80,
    category: 'Sides',
    image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Size',
        type: 'single',
        required: true,
        options: [
          { name: 'Regular', priceDiff: 0, isDefault: true },
          { name: 'Large', priceDiff: 40 },
        ],
      },
      {
        name: 'Dips',
        type: 'multi',
        required: false,
        min: 0,
        max: 2,
        options: [
          { name: 'Cheese dip', priceDiff: 25 },
          { name: 'Garlic mayo', priceDiff: 20 },
          { name: 'Ketchup', priceDiff: 0 },
        ],
      },
    ],
  },
  {
    name: 'Margherita Pizza',
    description: 'Seven inch, San Marzano sauce, mozzarella and basil.',
    price: 160,
    category: 'Pizza',
    image: 'https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Crust',
        type: 'single',
        required: true,
        options: [
          { name: 'Hand tossed', priceDiff: 0, isDefault: true },
          { name: 'Thin crust', priceDiff: 0 },
          { name: 'Cheese burst', priceDiff: 60 },
        ],
      },
      {
        name: 'Toppings',
        type: 'multi',
        required: false,
        min: 0,
        max: 4,
        options: [
          { name: 'Mushroom', priceDiff: 30 },
          { name: 'Olives', priceDiff: 25 },
          { name: 'Corn', priceDiff: 20 },
          { name: 'Extra cheese', priceDiff: 40 },
          { name: 'Paneer', priceDiff: 45 },
        ],
      },
    ],
  },
  {
    name: 'Penne Alfredo',
    description: 'Penne in a white sauce with herbs and parmesan.',
    price: 150,
    category: 'Pasta',
    image: 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Spice',
        type: 'single',
        required: false,
        options: [
          { name: 'Mild', priceDiff: 0, isDefault: true },
          { name: 'Chilli flakes', priceDiff: 0 },
        ],
      },
      {
        name: 'Add protein',
        type: 'single',
        required: false,
        options: [
          { name: 'None', priceDiff: 0, isDefault: true },
          { name: 'Grilled paneer', priceDiff: 50 },
          { name: 'Mushroom', priceDiff: 35 },
        ],
      },
    ],
  },
  {
    name: 'Oreo Thick Shake',
    description: 'Blended thick, topped with crushed Oreo.',
    price: 120,
    category: 'Shakes',
    image: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Add-ons',
        type: 'multi',
        required: false,
        min: 0,
        max: 2,
        options: [
          { name: 'Whipped cream', priceDiff: 20 },
          { name: 'Extra scoop', priceDiff: 35 },
        ],
      },
    ],
  },
  {
    name: 'Cold Coffee',
    description: 'Classic, thick and sweet.',
    price: 90,
    category: 'Shakes',
    image: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
  {
    name: 'Choco Lava Cake',
    description: 'Molten centre, served warm.',
    price: 70,
    category: 'Desserts',
    image: 'https://images.unsplash.com/photo-1624353365286-3f8d62daad51?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
];
