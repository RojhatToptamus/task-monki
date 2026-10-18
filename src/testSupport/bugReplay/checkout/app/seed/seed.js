'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { money } = require('../lib/pricing');

const products = [
  { id: 'widget', name: 'Widget', price: 25 },
  { id: 'gadget', name: 'Gadget', price: 40 }
];

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'store.json'),
  JSON.stringify({ products: products.map((product) => ({ ...product, label: money(product.price) })), orders: [] }, null, 2)
);
console.log(`Seeded ${products.length} products.`);
