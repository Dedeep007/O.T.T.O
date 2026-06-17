import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';
import { ui } from '../cli/ui.js';

export class VectorMemory {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(os.homedir(), '.otto_vectors.db');
    this.db = new Database(dbPath);
    sqliteVec.load(this.db); // Load the sqlite-vec extension
    
    // Create vector table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
        id INTEGER PRIMARY KEY,
        embedding float[1536] -- Assuming OpenAI embedding dimensions or Ollama dimensions
      );
      CREATE TABLE IF NOT EXISTS vec_memory_meta(
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        summary TEXT
      );
    `);
  }

  public storeSummary(sessionId: string, summary: string, embedding: number[]) {
    if (embedding.length !== 1536) {
      ui.warning(`Embedding dimension mismatch. Expected 1536, got ${embedding.length}`);
      // In a real scenario, the dimension should match the exact model used in Configurator.
      return;
    }

    const insertMeta = this.db.prepare('INSERT INTO vec_memory_meta (session_id, summary) VALUES (?, ?)');
    const info = insertMeta.run(sessionId, summary);
    const id = info.lastInsertRowid;

    const insertVec = this.db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)');
    insertVec.run(BigInt(id), new Float32Array(embedding));
  }

  public searchStrategies(queryEmbedding: number[], limit: number = 3): any[] {
    if (queryEmbedding.length !== 1536) return [];

    const stmt = this.db.prepare(`
      SELECT m.session_id, m.summary, v.distance
      FROM vec_memory v
      JOIN vec_memory_meta m ON v.id = m.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `);
    
    return stmt.all(new Float32Array(queryEmbedding), limit);
  }
}

export const vectorMemory = new VectorMemory();
