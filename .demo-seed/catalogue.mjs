// The demo catalogue: departments, products and the photo that represents each.
//
// `photo` is an Unsplash photo id; the seeder downloads it to uploads/ and
// verifies the bytes are a real JPEG before writing a product_images row.
// Prices are INCLUSIVE of VAT, in Rand, which is what product_prices stores.

export const DEPARTMENTS = [
  { key: 'burgers', name: 'Smash Burgers', code: 'BURG', color: '#c2410c', sort: 1 },
  { key: 'hotdogs', name: 'Gourmet Hotdogs', code: 'DOGS', color: '#b45309', sort: 2 },
  { key: 'pizza', name: 'Wood-Fired Pizza', code: 'PIZZ', color: '#b91c1c', sort: 3 },
  { key: 'sides', name: 'Sides & Loaded Fries', code: 'SIDE', color: '#a16207', sort: 4 },
  { key: 'drinks', name: 'Cooldrinks & Shakes', code: 'DRNK', color: '#0369a1', sort: 5 },
  { key: 'desserts', name: 'Desserts', code: 'DSRT', color: '#9d174d', sort: 6 },
]

export const BRANDS = ['House Made', 'Coca-Cola', 'Fanta', 'Sprite', 'Lipton']

// code, description, department, brand, price incl VAT, cost excl VAT, photo id, alt text
export const PRODUCTS = [
  // ── Smash Burgers ────────────────────────────────────────────────────
  ['SB-101', 'Classic Smash Burger', 'burgers', 'House Made', 89.0, 34.0, 'photo-1568901346375-23c9450c58cd', 'Classic smash burger with melted cheese'],
  ['SB-102', 'Double Smash Cheeseburger', 'burgers', 'House Made', 129.0, 52.0, 'photo-1610440042657-612c34d95e9f', 'Double smash cheeseburger stacked high'],
  ['SB-103', 'Bacon & Blue Smash', 'burgers', 'House Made', 139.0, 58.0, 'photo-1594212699903-ec8a3eca50f5', 'Bacon and blue cheese burger'],
  ['SB-104', 'Mushroom Swiss Smash', 'burgers', 'House Made', 132.0, 55.0, 'photo-1572802419224-296b0aeee0d9', 'Mushroom and swiss cheese burger'],
  ['SB-105', 'Jalapeño Fire Smash', 'burgers', 'House Made', 125.0, 50.0, 'photo-1550547660-d9450f859349', 'Spicy jalapeno burger with chilli'],
  ['SB-106', 'Crispy Chicken Deluxe', 'burgers', 'House Made', 119.0, 47.0, 'photo-1606755962773-d324e0a13086', 'Crispy fried chicken burger'],
  ['SB-107', 'Buttermilk Chicken Burger', 'burgers', 'House Made', 115.0, 45.0, 'photo-1513185158878-8d8c2a2a3da3', 'Buttermilk chicken burger with slaw'],
  ['SB-108', 'Beyond Veggie Smash', 'burgers', 'House Made', 122.0, 52.0, 'photo-1520072959219-c595dc870360', 'Plant based veggie burger'],
  ['SB-109', 'Triple Stack Monster', 'burgers', 'House Made', 175.0, 74.0, 'photo-1586190848861-99aa4a171e90', 'Triple patty stacked burger'],
  ['SB-110', 'Truffle & Onion Smash', 'burgers', 'House Made', 149.0, 63.0, 'photo-1561758033-d89a9ad46330', 'Truffle burger with caramelised onion'],
  ['SB-111', 'Kids Mini Smash', 'burgers', 'House Made', 65.0, 24.0, 'photo-1571091718767-18b5b1457add', 'Small kids burger with fries'],
  ['SB-112', 'BBQ Brisket Smash', 'burgers', 'House Made', 155.0, 66.0, 'photo-1547584370-2cc98b8b8dc8', 'BBQ brisket burger with sauce'],

  // ── Gourmet Hotdogs ──────────────────────────────────────────────────
  // Every photo here was checked by eye against the name — see the contact
  // sheets in .screenshots/. A plausible-looking id proves nothing.
  ['HD-201', 'New York Street Dog', 'hotdogs', 'House Made', 72.0, 27.0, 'photo-1612392061787-2d078b3e573c', 'New York style hotdog with mustard'],
  ['HD-202', 'Chilli Cheese Dog', 'hotdogs', 'House Made', 89.0, 35.0, 'photo-1619740455993-9e612b1af08a', 'Chilli cheese loaded hotdog'],
  ['HD-203', 'Street Tacos (3)', 'hotdogs', 'House Made', 98.0, 40.0, 'photo-1613514785940-daed07799d9b', 'Three street tacos with lime and salsa'],
  ['HD-204', 'Crispy Chicken Strips', 'hotdogs', 'House Made', 95.0, 39.0, 'photo-1626082927389-6cd097cdc6ec', 'Golden crispy fried chicken strips'],
  ['HD-205', 'Steak & Cheese Sub', 'hotdogs', 'House Made', 85.0, 33.0, 'photo-1509722747041-616f39b57569', 'Toasted sub roll with steak and salad'],
  ['HD-206', 'Chicken & Chips Basket', 'hotdogs', 'House Made', 105.0, 44.0, 'photo-1580217593608-61931cefc821', 'Fried chicken and chips basket'],

  // ── Wood-Fired Pizza ─────────────────────────────────────────────────
  ['PZ-301', 'Margherita', 'pizza', 'House Made', 129.0, 48.0, 'photo-1604382354936-07c5d9983bd3', 'Margherita pizza with fresh basil'],
  ['PZ-302', 'Pepperoni Classic', 'pizza', 'House Made', 149.0, 58.0, 'photo-1628840042765-356cda07504e', 'Pepperoni pizza fresh from the oven'],
  ['PZ-303', 'Four Cheese', 'pizza', 'House Made', 159.0, 64.0, 'photo-1513104890138-7c749659a591', 'Four cheese pizza melted golden'],
  ['PZ-304', 'BBQ Chicken & Bacon', 'pizza', 'House Made', 169.0, 70.0, 'photo-1565299624946-b28f40a0ae38', 'BBQ chicken and bacon pizza'],
  ['PZ-305', 'Meat Lovers', 'pizza', 'House Made', 189.0, 80.0, 'photo-1534308983496-4fabb1a015ee', 'Meat lovers pizza loaded with toppings'],
  ['PZ-306', 'Mushroom Truffle', 'pizza', 'House Made', 175.0, 73.0, 'photo-1571407970349-bc81e7e96d47', 'Wild mushroom and truffle pizza'],
  ['PZ-307', 'Hawaiian', 'pizza', 'House Made', 145.0, 56.0, 'photo-1594007654729-407eedc4be65', 'Hawaiian pizza with ham and pineapple'],
  ['PZ-308', 'Spicy Diavola', 'pizza', 'House Made', 165.0, 68.0, 'photo-1593560708920-61dd98c46a4e', 'Spicy salami diavola pizza'],
  ['PZ-309', 'Veggie Garden', 'pizza', 'House Made', 139.0, 54.0, 'photo-1511689660979-10d2b1aada49', 'Vegetable garden pizza'],
  ['PZ-310', 'Prosciutto & Rocket', 'pizza', 'House Made', 185.0, 78.0, 'photo-1595854341625-f33ee10dbf94', 'Prosciutto and rocket pizza'],

  // ── Sides & Loaded Fries ─────────────────────────────────────────────
  ['SD-401', 'Skin-On Fries', 'sides', 'House Made', 42.0, 14.0, 'photo-1573080496219-bb080dd4f877', 'Golden skin on fries'],
  ['SD-402', 'Loaded Cheese Fries', 'sides', 'House Made', 69.0, 26.0, 'photo-1585109649139-366815a0d713', 'Cheese loaded fries'],
  ['SD-403', 'Peri-Peri Seasoned Fries', 'sides', 'House Made', 79.0, 31.0, 'photo-1541592106381-b31e9677c0e5', 'Seasoned peri-peri fries'],
  ['SD-404', 'Cheesy Chicken Bowl', 'sides', 'House Made', 55.0, 20.0, 'photo-1604908176997-125f25cc6f3d', 'Cheesy chicken and vegetable bowl'],
  ['SD-405', 'Crispy Onion Rings', 'sides', 'House Made', 52.0, 19.0, 'photo-1639024471283-03518883512d', 'Crispy battered onion rings'],
  ['SD-406', 'Buffalo Chicken Wings', 'sides', 'House Made', 95.0, 38.0, 'photo-1608039755401-742074f0548d', 'Buffalo chicken wings with sauce'],
  ['SD-407', 'Mozzarella Sticks', 'sides', 'House Made', 65.0, 25.0, 'photo-1531749668029-2db88e4276c7', 'Fried mozzarella sticks'],
  ['SD-408', 'Ketchup Fries Regular', 'sides', 'House Made', 32.0, 10.0, 'photo-1518013431117-eb1465fa5752', 'Regular fries with ketchup'],

  // ── Cooldrinks & Shakes ──────────────────────────────────────────────
  ['DR-501', 'Coca-Cola 330ml', 'drinks', 'Coca-Cola', 25.0, 9.0, 'photo-1554866585-cd94860890b7', 'Chilled can of Coca-Cola'],
  ['DR-502', 'Coke Zero 330ml', 'drinks', 'Coca-Cola', 25.0, 9.0, 'photo-1622483767028-3f66f32aef97', 'Can of Coke Zero'],
  ['DR-503', 'Fanta Orange 330ml', 'drinks', 'Fanta', 25.0, 9.0, 'photo-1624517452488-04869289c4ca', 'Bottle of orange Fanta'],
  ['DR-504', 'Sprite 330ml', 'drinks', 'Sprite', 25.0, 9.0, 'photo-1625772299848-391b6a87d7b3', 'Can of Sprite lemonade'],
  ['DR-505', 'Orange Squeeze Tall', 'drinks', 'House Made', 32.0, 13.0, 'photo-1600271886742-f049cd451bba', 'Tall glass of fresh orange juice'],
  ['DR-506', 'Energy Drink 500ml', 'drinks', 'House Made', 38.0, 17.0, 'photo-1622543925917-763c34d1a86e', 'Chilled can of energy drink'],
  ['DR-507', 'Iced Citrus Cooler', 'drinks', 'House Made', 18.0, 6.0, 'photo-1560023907-5f339617ea30', 'Iced citrus cooler by a window'],
  ['DR-508', 'Iced Lemon Tea', 'drinks', 'Lipton', 28.0, 11.0, 'photo-1499638673689-79a0b5115d87', 'Glass of iced lemon tea'],
  ['DR-509', 'Chocolate Milkshake', 'drinks', 'House Made', 55.0, 20.0, 'photo-1572490122747-3968b75cc699', 'Thick chocolate milkshake'],
  ['DR-510', 'Caramel Fudge Shake', 'drinks', 'House Made', 55.0, 20.0, 'photo-1553787499-6f9133860278', 'Caramel fudge milkshake with cream'],
  ['DR-511', 'Cookies & Cream Shake', 'drinks', 'House Made', 62.0, 24.0, 'photo-1638176066666-ffb2f013c7dd', 'Cookies and cream milkshake with sauce'],
  ['DR-512', 'Fresh Orange Juice', 'drinks', 'House Made', 35.0, 14.0, 'photo-1621506289937-a8e4df240d0b', 'Freshly squeezed orange juice'],

  // ── Desserts ─────────────────────────────────────────────────────────
  ['DS-601', 'Belgian Chocolate Brownie', 'desserts', 'House Made', 58.0, 21.0, 'photo-1606313564200-e75d5e30476c', 'Chocolate brownie with fudge'],
  ['DS-602', 'New York Cheesecake', 'desserts', 'House Made', 68.0, 26.0, 'photo-1533134242443-d4fd215305ad', 'Slice of New York cheesecake'],
  ['DS-603', 'Warm Churros', 'desserts', 'House Made', 52.0, 19.0, 'photo-1624371414361-e670edf4898d', 'Warm churros with cinnamon sugar'],
  ['DS-604', 'Soft Serve Sundae', 'desserts', 'House Made', 45.0, 16.0, 'photo-1563805042-7684c019e1cb', 'Soft serve ice cream sundae'],
]

// Banner / hero photography for the storefront itself.
export const STOREFRONT_IMAGES = [
  { key: 'hero', photo: 'photo-1561758033-d89a9ad46330', alt: 'Smash burger and fries on a board' },
  { key: 'pizza', photo: 'photo-1513104890138-7c749659a591', alt: 'Wood-fired pizza fresh from the oven' },
]
