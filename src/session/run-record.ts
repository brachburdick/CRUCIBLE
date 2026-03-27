/**
 * Run Records — audit trail for every session that completes work.
 *
 * Every pipeline execution that modifies state must produce a run record.
 * The session model warns if the session ends without one.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { RunRecord, HumanTouches, RunResult, TaskType } from './types.js';

const RUNS_FILENAME = 'runs.jsonl';

export function emptyHumanTouches(): HumanTouches {
  return {
    questions: 0,
    corrections: 0,
    escalations: 0,
    approvals: 0,
    total: 0,
  };
}

export function createRunRecord(
  fields: Omit<RunRecord, 'runId' | 'date' | 'humanTouches'> & {
    humanTouches?: Partial<HumanTouches>;
  }
): RunRecord {
  const ht = { ...emptyHumanTouches(), ...fields.humanTouches };
  ht.total = ht.questions + ht.corrections + ht.escalations + ht.approvals;
  return {
    ...fields,
    runId: `run-${crypto.randomUUID().slice(0, 8)}`,
    date: new Date().toISOString(),
    humanTouches: ht,
  };
}

export class RunRecordStore {
  private records: RunRecord[] = [];
  private readonly runsPath: string;

  constructor(private readonly agentDir: string) {
    this.runsPath = path.join(agentDir, RUNS_FILENAME);
  }

  /** Load all run records from .agent/runs.jsonl. */
  async load(): Promise<RunRecord[]> {
    this.records = [];
    try {
      const raw = await fs.readFile(this.runsPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        this.records.push(JSON.parse(line) as RunRecord);
      }
    } catch {
      // No runs file yet.
    }
    return this.records;
  }

  /** Append a run record to .agent/runs.jsonl. */
  async append(record: RunRecord): Promise<void> {
    this.records.push(record);
    await fs.mkdir(path.dirname(this.runsPath), { recursive: true });
    await fs.appendFile(this.runsPath, JSON.stringify(record) + '\n', 'utf-8');
  }

  /** Get all run records. */
  all(): RunRecord[] {
    return [...this.records];
  }

  /** Get run records for a specific task. */
  forTask(taskId: string): RunRecord[] {
    return this.records.filter(r => r.taskId === taskId);
  }

  /** Check if any run record exists for the current session's work. */
  hasRecordForTask(taskId: string): boolean {
    return this.records.some(r => r.taskId === taskId);
  }

  /** Get the most recent N run records. */
  recent(n: number): RunRecord[] {
    return this.records.slice(-n);
  }
}
