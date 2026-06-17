import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

export class DBManager {
  private db: Database.Database;
  public saver: SqliteSaver;

  constructor() {
    const dbPath = path.join(os.homedir(), '.otto_checkpoint.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS otto_threads (
        id TEXT PRIMARY KEY,
        display_name TEXT DEFAULT 'New Chat',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS otto_thread_state (
        thread_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS otto_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    this.ensureThreadColumns();

    this.saver = new SqliteSaver(this.db);
  }

  private ensureThreadColumns() {
    const columns = this.db.prepare(`PRAGMA table_info(otto_threads)`).all() as { name: string }[];
    const hasDisplayName = columns.some(col => col.name === 'display_name');
    if (!hasDisplayName) {
      this.db.exec(`ALTER TABLE otto_threads ADD COLUMN display_name TEXT DEFAULT 'New Chat'`);
      this.db.exec(`UPDATE otto_threads SET display_name = 'New Chat' WHERE display_name IS NULL OR TRIM(display_name) = ''`);
    }
  }

  private tableExists(tableName: string): boolean {
    const row = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(tableName) as { name: string } | undefined;
    return !!row?.name;
  }

  public async setup() {
    await (this.saver as any).setup();
  }

  public setLastActiveThread(id: string) {
    this.db.prepare(`
      INSERT INTO otto_meta (key, value) VALUES ('last_active_thread', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(id);
  }

  public getLastActiveThread(): string | null {
    const row = this.db.prepare(`SELECT value FROM otto_meta WHERE key = 'last_active_thread'`).get() as { value: string } | undefined;
    return row?.value || null;
  }

  public registerThread(id: string, displayName?: string) {
    const stmt = this.db.prepare(`
      INSERT INTO otto_threads (id, display_name) VALUES (?, COALESCE(?, 'New Chat'))
      ON CONFLICT(id) DO UPDATE SET 
        display_name = COALESCE(?, otto_threads.display_name),
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(id, displayName ?? null, displayName ?? null);
  }

  public listThreads() {
    const stmt = this.db.prepare(`
      SELECT 
        id, 
        COALESCE(NULLIF(TRIM(display_name), ''), 'New Chat') AS display_name, 
        created_at, 
        updated_at 
      FROM otto_threads 
      ORDER BY updated_at DESC
    `);
    return (stmt.all() as any[]).map(row => ({
      id: row.id,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public getThread(id: string) {
    const stmt = this.db.prepare(`
      SELECT 
        id, 
        COALESCE(NULLIF(TRIM(display_name), ''), 'New Chat') AS display_name, 
        created_at, 
        updated_at 
      FROM otto_threads 
      WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public updateThreadName(id: string, displayName: string) {
    this.db.prepare(`
      UPDATE otto_threads 
      SET display_name = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(displayName, id);
  }

  public saveThreadMessages(id: string, messages: any[]) {
    this.db.prepare(`
      INSERT INTO otto_thread_state (thread_id, messages_json)
      VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, JSON.stringify(messages ?? []));
  }

  public loadThreadMessages(id: string): any[] {
    const row = this.db.prepare(`
      SELECT messages_json 
      FROM otto_thread_state 
      WHERE thread_id = ?
    `).get(id) as { messages_json: string } | undefined;

    if (!row?.messages_json) return [];
    try {
      const parsed = JSON.parse(row.messages_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public deleteThread(id: string) {
    this.db.prepare('DELETE FROM otto_threads WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM otto_thread_state WHERE thread_id = ?').run(id);
    if (this.tableExists('checkpoints')) {
      this.db.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(id);
    }
    if (this.tableExists('checkpoint_blobs')) {
      this.db.prepare('DELETE FROM checkpoint_blobs WHERE thread_id = ?').run(id);
    }
    if (this.tableExists('checkpoint_writes')) {
      this.db.prepare('DELETE FROM checkpoint_writes WHERE thread_id = ?').run(id);
    }
  }

  public deleteAllThreads() {
    this.db.prepare('DELETE FROM otto_threads').run();
    this.db.prepare('DELETE FROM otto_thread_state').run();
    if (this.tableExists('checkpoints')) {
      this.db.prepare('DELETE FROM checkpoints').run();
    }
    if (this.tableExists('checkpoint_blobs')) {
      this.db.prepare('DELETE FROM checkpoint_blobs').run();
    }
    if (this.tableExists('checkpoint_writes')) {
      this.db.prepare('DELETE FROM checkpoint_writes').run();
    }
  }
}

export const dbManager = new DBManager();
