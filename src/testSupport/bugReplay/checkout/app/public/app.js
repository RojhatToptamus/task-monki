'use strict';

const state = { products: [], items: [], discount: 0, coupon: null };

function money(value) {
  return `$${value.toFixed(2)}`;
}

function subtotal() {
  return state.items.reduce((sum, item) => {
    const product = state.products.find((candidate) => candidate.id === item.id);
    return product ? sum + product.price * item.quantity : sum;
  }, 0);
}

function total() {
  return subtotal() - state.discount * 2;
}

function render() {
  document.getElementById('cart-total').textContent = money(total());
}

function add(id) {
  const existing = state.items.find((item) => item.id === id);
  if (existing) existing.quantity += 1;
  else state.items.push({ id, quantity: 1 });
  render();
}

async function applyCoupon() {
  const code = document.getElementById('coupon').value;
  const error = document.getElementById('coupon-error');
  const response = await fetch('/api/coupons/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const body = await response.json();
  if (!response.ok) {
    error.textContent = body.error || 'Coupon not applied';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  state.discount = body.discount;
  state.coupon = body.code;
  document.getElementById('coupon-status').textContent = `Coupon ${body.code} applied`;
  render();
}

async function checkout() {
  const status = document.getElementById('order-status');
  status.textContent = 'Placing order…';
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: state.items, coupon: state.coupon, total: total() })
  });
  const body = await response.json();
  if (!response.ok) {
    status.textContent = body.error || 'The order failed';
    return;
  }
  status.textContent = `Order #${body.id} placed`;
  document.getElementById('order-total').textContent = `Order total: ${money(body.total)}`;
}

async function load() {
  state.products = await (await fetch('/api/products')).json();
  const list = document.getElementById('products');
  for (const product of state.products) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Add ${product.name}`;
    button.dataset.testid = `add-${product.id}`;
    button.addEventListener('click', () => add(product.id));
    list.append(button, ' ');
  }
  render();
  const last = await fetch('/api/orders/last');
  if (last.ok) {
    const order = await last.json();
    document.getElementById('order-total').textContent = `Order total: ${money(order.total)}`;
  }
}

document.getElementById('apply').addEventListener('click', applyCoupon);
document.getElementById('checkout').addEventListener('click', checkout);
const updates = new EventSource('/events');
updates.onmessage = () => {
  const counter = document.getElementById('updates');
  counter.textContent = String(Number(counter.textContent) + 1);
};
void load();
