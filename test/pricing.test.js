import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents,
  centsToMoney,
  validateDiscount,
  computeVariantPlan,
} from '../src/promoManager.js';

test('toCents & centsToMoney conversion', () => {
  assert.equal(toCents('19.90'), 1990);
  assert.equal(toCents('0.00'), 0);
  assert.equal(toCents(null), null);
  assert.equal(toCents(''), null);
  assert.equal(centsToMoney(1990), '19.90');
  assert.equal(centsToMoney(500), '5.00');
  assert.equal(centsToMoney(5), '0.05');
});

test('validateDiscount boundaries', () => {
  assert.deepEqual(validateDiscount(40), { ok: true, value: 40 });
  assert.deepEqual(validateDiscount('33.5'), { ok: true, value: 33.5 });
  assert.deepEqual(validateDiscount('33,5'), { ok: true, value: 33.5 });
  assert.equal(validateDiscount(4).ok, false);
  assert.equal(validateDiscount(71).ok, false);
  assert.deepEqual(validateDiscount(70), { ok: true, value: 70 });
  assert.equal(validateDiscount('invalid').ok, false);
  assert.equal(validateDiscount('').ok, false);
});

test('computeVariantPlan - standard item without compareAtPrice', () => {
  // Product at 100.00, no compareAtPrice, discount -40%
  const variant = { id: 'gid://shopify/ProductVariant/1', price: '100.00', compareAtPrice: null };
  const plan = computeVariantPlan(variant, 40);

  assert.equal(plan.action, 'update');
  assert.equal(plan.newPrice, '60.00');
  assert.equal(plan.newCompareAtPrice, '100.00');
});

test('computeVariantPlan - product already discounted with compareAtPrice', () => {
  // Product with compareAtPrice: 100.00, current price: 70.00. Discount: -40%
  // Base is compareAtPrice (100.00) => newPrice = 60.00, newCompareAtPrice = 100.00
  const variant = { id: 'gid://shopify/ProductVariant/2', price: '70.00', compareAtPrice: '100.00' };
  const plan = computeVariantPlan(variant, 40);

  assert.equal(plan.action, 'update');
  assert.equal(plan.newPrice, '60.00');
  assert.equal(plan.newCompareAtPrice, '100.00');
});

test('computeVariantPlan - neverIncreasePrice option prevents raising already deep discounts', () => {
  // Product with compareAtPrice: 100.00, but already heavily discounted to 50.00.
  // New promo is -20% (would be 80.00).
  const variant = { id: 'gid://shopify/ProductVariant/3', price: '50.00', compareAtPrice: '100.00' };

  // With neverIncreasePrice: true, it skips since price is already 50.00 and compareAtPrice is 100.00
  const planSafe = computeVariantPlan(variant, 20, { neverIncreasePrice: true });
  assert.equal(planSafe.action, 'skip');
  assert.equal(planSafe.reason, 'Déjà soldé à un prix inférieur ou égal');

  // With neverIncreasePrice: false, price would jump to 80.00
  const planStrict = computeVariantPlan(variant, 20, { neverIncreasePrice: false });
  assert.equal(planStrict.action, 'update');
  assert.equal(planStrict.newPrice, '80.00');
  assert.equal(planStrict.keptExistingSale, false);
});

test('computeVariantPlan - skips free or zero price items', () => {
  const variant = { id: 'gid://shopify/ProductVariant/4', price: '0.00', compareAtPrice: null };
  const plan = computeVariantPlan(variant, 40);
  assert.equal(plan.action, 'skip');
});
