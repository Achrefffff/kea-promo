import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStorage } from '../src/storage.js';

test('Storage adapter fallback to file operations', async () => {
  const testDir = path.resolve('test-data-tmp');
  const storage = createStorage({ dataDir: testDir, logger: { log() {}, warn() {}, error() {} } });

  await storage.init();

  // Test state read/write
  const initialState = await storage.readState({ defaultVal: true });
  assert.equal(initialState.defaultVal, true);

  await storage.writeState({ isPromoActive: true, discountPercentage: 30 });
  const savedState = await storage.readState();
  assert.equal(savedState.isPromoActive, true);
  assert.equal(savedState.discountPercentage, 30);

  // Test backup read/write
  assert.equal(await storage.readBackup(), null);
  await storage.writeBackup({ shop: 'test.myshopify.com', products: [{ id: 1 }] });
  const backup = await storage.readBackup();
  assert.equal(backup.shop, 'test.myshopify.com');
  assert.equal(backup.products.length, 1);

  // Test archive backup
  const archived = await storage.archiveBackup('test');
  assert.ok(archived);
  assert.equal(await storage.readBackup(), null);

  // Test audit logs
  await storage.appendAudit('test_event', 'user@test.com', { foo: 'bar' });
  const logs = await storage.readAudit({ limit: 5 });
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].event, 'test_event');
  assert.equal(logs[0].email, 'user@test.com');
  assert.ok(logs[0].ts);

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});
