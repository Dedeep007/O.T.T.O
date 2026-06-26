import { ChatUI, translateInkKey } from '../src/cli/chat.js';
import { PhoneOS } from '../src/cli/nav.js';
import { ui } from '../src/cli/ui.js';
import assert from 'assert';

async function runTests() {
  console.log("=== STARTING UX FEATURES VERIFICATION TESTS ===");

  // 1. Test Key Translation for Backspace variations on Windows
  console.log("Testing translateInkKey for Backspace variations...");
  const k1 = translateInkKey('', { backspace: true });
  assert.strictEqual(k1.name, 'backspace', "Ink key.backspace should map to backspace");

  const k2 = translateInkKey('', { delete: true });
  assert.strictEqual(k2.name, 'backspace', "Ink key.delete should map to backspace");

  const k3 = translateInkKey('\x7f', {});
  assert.strictEqual(k3.name, 'backspace', "Character \\x7f should map to backspace");

  const k4 = translateInkKey('\x08', {});
  assert.strictEqual(k4.name, 'backspace', "Character \\x08 should map to backspace");
  
  console.log("✓ Key translation verified successfully.");

  // 2. Test Notification system in ChatUI
  console.log("Testing ChatUI notification system...");
  const chatUI = new ChatUI();
  chatUI.showNotification("Switched to Groq");
  assert.strictEqual(chatUI.notification, "Switched to Groq", "Notification message should be set");
  
  // Verify that the notification is painted in drawToString
  chatUI.render([], 'hello', { ctxMax: 1000, ctxUsed: 100, ramMB: 200, showContextBar: true }, 'test-model');
  const frameWithNotification = chatUI.drawToString();
  assert.ok(frameWithNotification.includes("✓ Switched to Groq"), "Notification should be visible in chat output frame");
  console.log("✓ ChatUI notification system verified.");

  // 3. Test Text Cursor visibility in ChatUI
  console.log("Testing text cursor rendering in ChatUI...");
  // Under normal editing condition, a cursor should be appended
  assert.ok(frameWithNotification.includes("hello█"), "Brand-colored cursor should be rendered after current input");
  
  // Under thinking condition, no cursor should be shown
  chatUI.render([], 'hello', { ctxMax: 1000, ctxUsed: 100, ramMB: 200, showContextBar: true }, 'test-model', true); // isThinking = true
  const frameThinking = chatUI.drawToString();
  assert.ok(!frameThinking.includes("hello█"), "Cursor should not render when thinking is active");
  console.log("✓ Text cursor visibility logic verified.");

  // 4. Test Notification system in PhoneOS
  console.log("Testing PhoneOS notification system...");
  const phone = new PhoneOS({
    defaults: { primaryProvider: 'ollama', showContextBar: true },
    providers: {
      ollama: { activeModel: 'llama3', baseUrl: 'http://localhost:11434' }
    },
    security: { mode: 'approve', allowedCommands: [], allowedApps: [] }
  } as any);
  phone.pushView({
    id: 'test',
    title: 'Test Title',
    options: []
  });
  phone.showNotification("Config Saved");
  assert.strictEqual(phone.notification, "Config Saved", "PhoneOS notification message should be set");
  const phoneFrame = phone.drawToString();
  assert.ok(phoneFrame.includes("✓ Config Saved"), "Notification should be visible in PhoneOS drawToString output");
  console.log("✓ PhoneOS notification system verified.");

  // 5. Test UI console redirects when tuiActive is true
  console.log("Testing ui logs redirect logic...");
  ui.tuiActive = true;
  let receivedType: string | null = null;
  let receivedText: string | null = null;
  ui.onTuiMessage = (type, text) => {
    receivedType = type;
    receivedText = text;
  };

  ui.success("Configuration loaded successfully");
  assert.strictEqual(receivedType, 'success');
  assert.strictEqual(receivedText, "Configuration loaded successfully");

  ui.info("Connecting to model...");
  assert.strictEqual(receivedType, 'info');
  assert.strictEqual(receivedText, "Connecting to model...");
  console.log("✓ UI logs redirection verified.");

  console.log("=== ALL UX TESTS COMPLETED SUCCESSFULLY ===");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
