import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  variant TEXT NOT NULL,
  task_file TEXT NOT NULL,
  task_json TEXT NOT NULL,
  budget INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  exit_reason TEXT,
  token_count INTEGER DEFAULT 0,
  wall_time_ms INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  event TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
`;

export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join('data', 'crucible.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ─── Query helpers ──────────────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  agent: string;
  variant: string;
  task_file: string;
  task_json: string;
  budget: number;
  ttl_seconds: number;
  status: string;
  exit_reason: string | null;
  token_count: number;
  wall_time_ms: number | null;
  started_at: string;
  completed_at: string | null;
}

export interface RunEventRow {
  id: number;
  run_id: string;
  event: string;
  data: string;
  timestamp: string;
}

export function insertRun(db: Database.Database, run: {
  id: string;
  agent: string;
  variant: string;
  taskFile: string;
  taskJson: string;
  budget: number;
  ttlSeconds: number;
  startedAt: string;
}): void {
  db.prepare(`
    INSERT INTO runs (id, agent, variant, task_file, task_json, budget, ttl_seconds, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.id, run.agent, run.variant, run.taskFile, run.taskJson, run.budget, run.ttlSeconds, run.startedAt);
}

export function completeRun(db: Database.Database, id: string, update: {
  status: string;
  exitReason: string;
  tokenCount: number;
  wallTimeMs: number;
  completedAt: string;
}): void {
  db.prepare(`
    UPDATE runs SET status = ?, exit_reason = ?, token_count = ?, wall_time_ms = ?, completed_at = ?
    WHERE id = ?
  `).run(update.status, update.exitReason, update.tokenCount, update.wallTimeMs, update.completedAt, id);
}

export function insertRunEvent(db: Database.Database, event: {
  runId: string;
  event: string;
  data: string;
  timestamp: string;
}): void {
  db.prepare(`
    INSERT INTO run_events (run_id, event, data, timestamp) VALUES (?, ?, ?, ?)
  `).run(event.runId, event.event, event.data, event.timestamp);
}

export function listRuns(db: Database.Database, opts?: {
  status?: string;
  limit?: number;
  offset?: number;
}): RunRow[] {
  let sql = 'SELECT * FROM runs';
  const params: unknown[] = [];

  if (opts?.status) {
    sql += ' WHERE status = ?';
    params.push(opts.status);
  }

  sql += ' ORDER BY started_at DESC';

  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  if (opts?.offset) {
    sql += ' OFFSET ?';
    params.push(opts.offset);
  }

  return db.prepare(sql).all(...params) as RunRow[];
}

export function getRun(db: Database.Database, id: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
}

export function getRunEvents(db: Database.Database, runId: string): RunEventRow[] {
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC').all(runId) as RunEventRow[];
}
