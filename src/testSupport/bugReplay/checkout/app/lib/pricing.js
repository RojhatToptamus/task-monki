'use strict';

// Shared by the server and the seed: catalogue prices and coupon rules.
const COUPONS = {
  SAVE5: { amount: 5, expires: '2099-01-01' },
  OLD10: { amount: 10, expires: '2020-01-01' }
};

function couponFor(code) {
  return COUPONS[String(code || '').trim().toUpperCase()];
}

function isExpired(coupon, now = new Date()) {
  return new Date(coupon.expires) < now;
}

function subtotal(items, products) {
  return items.reduce((sum, item) => {
    const product = products.find((candidate) => candidate.id === item.id);
    return product ? sum + product.price * item.quantity : sum;
  }, 0);
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

module.exports = { couponFor, isExpired, subtotal, money };
