import { ChatUI } from '../src/cli/chat.js';
import { snapshotManager } from '../src/cli/snapshots.js';
import { captureWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../src/cli/workspaceDiff.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

async function runTests() {
  console.log("=== STARTING CANCELLATION AND SNAPSHOT TESTS ===");

  // 1. Test ChatUI draws the correct placeholder when streaming or thinking is active
  console.log("Testing placeholder when streaming/thinking is active...");
  const chatUI = new ChatUI();

  // Test when isStreaming = true
  chatUI.render([], '', { ctxMax: 1000, ctxUsed: 100, ramMB: 200, showContextBar: true, isStreaming: true }, 'test-model');
  let output = chatUI.drawToString();
  assert.ok(output.includes("Press [Ctrl+X] to terminate streaming"), "Should print Press [Ctrl+X] placeholder when isStreaming is true");

  // Test when isThinking = true
  chatUI.render([], '', { ctxMax: 1000, ctxUsed: 100, ramMB: 200, showContextBar: true, isStreaming: false }, 'test-model', true);
  output = chatUI.drawToString();
  assert.ok(output.includes("Press [Ctrl+X] to terminate streaming"), "Should print Press [Ctrl+X] placeholder when isThinking is true");

  console.log("✓ Placeholder rendering verified.");

  // 2. Test Workspace Snapshot capture and restore
  console.log("Testing workspace snapshot manager...");
  const tempFile = path.join(process.cwd(), 'scratch', 'temp_test_file.txt');
  
  // Make sure to clean up any old test files
  if (fs.existsSync(tempFile)) {
    fs.unlinkSync(tempFile);
  }

  // Capture before state
  const beforeSnap = captureWorkspaceSnapshot();
  assert.ok(!beforeSnap.has('scratch/temp_test_file.txt'), "Before snapshot should not have the temp file");

  // Create file
  fs.writeFileSync(tempFile, 'Hello World!', 'utf8');

  // Capture after state
  const afterSnap = captureWorkspaceSnapshot();
  assert.ok(afterSnap.has('scratch/temp_test_file.txt'), "After snapshot should have the temp file");
  assert.strictEqual(afterSnap.get('scratch/temp_test_file.txt'), 'Hello World!');

  // Restore state
  restoreWorkspaceSnapshot(beforeSnap);
  assert.ok(!fs.existsSync(tempFile), "Temp file should be deleted after restoring the before snapshot");

  console.log("✓ Workspace snapshot capture and restore verified.");

  // 3. Test Snapshot Manager thread checkpoints
  console.log("Testing snapshotManager checkpoints...");
  const testThreadId = 'test-thread-xyz';
  
  // Clean up any old checkpoint directory
  snapshotManager.deleteThreadSnapshots(testThreadId);

  // Capture checkpoint 0 (empty workspace)
  snapshotManager.saveCheckpoint(testThreadId, 0);

  // Modify file
  fs.writeFileSync(tempFile, 'Updated Content', 'utf8');

  // Capture checkpoint 1
  snapshotManager.saveCheckpoint(testThreadId, 1);

  // Modify file again
  fs.writeFileSync(tempFile, 'Second Update', 'utf8');

  // Restore checkpoint 1
  let ok = snapshotManager.restoreCheckpoint(testThreadId, 1);
  assert.ok(ok, "Checkpoint 1 should restore successfully");
  assert.strictEqual(fs.readFileSync(tempFile, 'utf8'), 'Updated Content', "Content should be restored to checkpoint 1");

  // Restore checkpoint 0
  ok = snapshotManager.restoreCheckpoint(testThreadId, 0);
  assert.ok(ok, "Checkpoint 0 should restore successfully");
  assert.ok(!fs.existsSync(tempFile), "Temp file should not exist in checkpoint 0");

  // Clean up snapshots
  snapshotManager.deleteThreadSnapshots(testThreadId);

  console.log("✓ SnapshotManager checkpoint save, restore and deletion verified.");
  console.log("=== ALL CANCELLATION AND SNAPSHOT TESTS PASSED ===");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
