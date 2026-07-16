// Menu items for Nescafé Corner.
//
// `modifiers` shape: groups have a name, a type ('single' renders radios,
// 'multi' renders checkboxes and honours min/max), and options carrying a
// priceDiff added to the item's base price. Students pay base + selected
// deltas, and nothing further.

module.exports = [
  {
    name: 'Cappuccino',
    description: 'Double shot espresso with steamed milk and a thick foam cap.',
    price: 70,
    category: 'Hot Coffee',
    image: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Size',
        type: 'single',
        required: true,
        options: [
          { name: 'Regular (200ml)', priceDiff: 0, isDefault: true },
          { name: 'Large (300ml)', priceDiff: 25 },
        ],
      },
      {
        name: 'Milk',
        type: 'single',
        required: false,
        options: [
          { name: 'Full cream', priceDiff: 0, isDefault: true },
          { name: 'Toned', priceDiff: 0 },
          { name: 'Oat milk', priceDiff: 20 },
        ],
      },
      {
        name: 'Extras',
        type: 'multi',
        required: false,
        min: 0,
        max: 3,
        options: [
          { name: 'Extra shot', priceDiff: 25 },
          { name: 'Hazelnut syrup', priceDiff: 15 },
          { name: 'Whipped cream', priceDiff: 15 },
          { name: 'Cocoa dusting', priceDiff: 0 },
        ],
      },
    ],
  },
  {
    name: 'Filter Coffee',
    description: 'South Indian style degree coffee, strong and frothy.',
    price: 40,
    category: 'Hot Coffee',
    image: 'https://images.unsplash.com/photo-1521302080334-4bebac2763a6?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Sweetness',
        type: 'single',
        required: false,
        options: [
          { name: 'Regular', priceDiff: 0, isDefault: true },
          { name: 'Less sugar', priceDiff: 0 },
          { name: 'No sugar', priceDiff: 0 },
        ],
      },
    ],
  },
  {
    name: 'Cold Brew',
    description: 'Steeped 18 hours, served over ice. Smooth and low acidity.',
    price: 110,
    category: 'Cold Coffee',
    image: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Serve',
        type: 'single',
        required: true,
        options: [
          { name: 'Black', priceDiff: 0, isDefault: true },
          { name: 'With milk', priceDiff: 10 },
          { name: 'Vanilla sweet cream', priceDiff: 30 },
        ],
      },
    ],
  },
  {
    name: 'Iced Latte',
    description: 'Chilled espresso, cold milk, plenty of ice.',
    price: 95,
    category: 'Cold Coffee',
    image: 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Flavour',
        type: 'single',
        required: false,
        options: [
          { name: 'Classic', priceDiff: 0, isDefault: true },
          { name: 'Caramel', priceDiff: 15 },
          { name: 'Mocha', priceDiff: 20 },
        ],
      },
    ],
  },
  {
    name: 'Veg Grilled Sandwich',
    description: 'Cheese, capsicum, onion and tomato pressed on a grill.',
    price: 80,
    category: 'Quick Bites',
    image: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Bread',
        type: 'single',
        required: true,
        options: [
          { name: 'White', priceDiff: 0, isDefault: true },
          { name: 'Brown', priceDiff: 0 },
          { name: 'Multigrain', priceDiff: 10 },
        ],
      },
      {
        name: 'Add-ons',
        type: 'multi',
        required: false,
        min: 0,
        max: 2,
        options: [
          { name: 'Extra cheese', priceDiff: 20 },
          { name: 'Jalapeños', priceDiff: 10 },
          { name: 'Peri peri sprinkle', priceDiff: 0 },
        ],
      },
    ],
  },
  {
    name: 'Chocolate Croissant',
    description: 'Flaky, buttery, filled with dark chocolate batons.',
    price: 65,
    category: 'Quick Bites',
    image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=800&q=80',
    modifiers: [],
  },
  {
    name: 'Banana Walnut Cake',
    description: 'Moist slice, served warm on request.',
    price: 60,
    category: 'Bakery',
    image: 'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?auto=format&fit=crop&w=800&q=80',
    modifiers: [
      {
        name: 'Serve',
        type: 'single',
        required: false,
        options: [
          { name: 'Room temperature', priceDiff: 0, isDefault: true },
          { name: 'Warmed', priceDiff: 0 },
        ],
      },
    ],
  },
];
