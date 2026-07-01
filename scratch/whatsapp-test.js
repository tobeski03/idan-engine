const whatsapp = require('../whatsapp');
const assert = require('assert');

async function runTest() {
  console.log('--- Starting whatsapp.js tests ---');

  // Test 1: Check initial status
  const status = whatsapp.getWhatsAppStatus();
  console.log('Initial Status:', status);
  assert.strictEqual(status.status, 'disconnected');
  assert.strictEqual(status.pairingCode, null);
  assert.strictEqual(status.phoneNumber, null);
  console.log('✓ Initial status check passed');

  // Test 2: Check disconnect resets status
  await whatsapp.disconnectWhatsApp();
  const postDisconnectStatus = whatsapp.getWhatsAppStatus();
  assert.strictEqual(postDisconnectStatus.status, 'disconnected');
  console.log('✓ Disconnect status check passed');

  console.log('--- All whatsapp.js tests passed successfully ---');
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
