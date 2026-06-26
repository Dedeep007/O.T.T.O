import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), '.otto_checkpoint.db');
const db = new Database(dbPath);
const row = db.prepare('SELECT messages_json FROM otto_thread_state WHERE thread_id = ?').get('session-tlw94a');

if (row && row.messages_json) {
  const msgs = JSON.parse(row.messages_json);
  msgs.forEach((m, idx) => {
    console.log(`\n--- Message ${idx} [${m.id?.join('/') || m.type || 'unknown'}] ---`);
    console.log(m.data?.content || m.content || JSON.stringify(m));
    if (m.data?.tool_calls) {
      console.log(`Tool Calls: ${JSON.stringify(m.data.tool_calls, null, 2)}`);
    }
  });
} else {
  console.log('No messages found for session-tlw94a.');
}
db.close();
