/**
 * State Snapshot — session continuity across pipeline runs.
 *
 * Saves/loads session state to .agent/state-snapshot.json so that
 * subsequent runs can skip re-exploration by loading prior decisions,
 * key locations, and dead ends.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  StateSnapshot,
  SessionKnowledge,
  SessionFriction,
  DecisionEntry,
  KeyLocation,
  DeadEnd,
} from './types.js';

const SNAPSHOT_FILENAME = 'state-snapshot.json';

export function emptyKnowledge(): SessionKnowledge {
  return {
    decisions: [],
    keyLocations: [],
    deadEnds: [],
    openQuestions: [],
  };
}

export function emptyFriction(): SessionFriction {
  return {
    mutationsSinceTest: 0,
    totalMutations: 0,
    testCycles: 0,
    uniqueFilesModified: [],
  };
}

export function createSnapshot(overrides?: Partial<StateSnapshot>): StateSnapshot {
  return {
    sessionId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    branch: '',
    lastCommit: '',
    activeTasks: [],
    modifiedFiles: [],
    sessionKnowledge: emptyKnowledge(),
    sessionFriction: emptyFriction(),
    ...overrides,
  };
}

export class StateSnapshotManager {
  private snapshot: StateSnapshot;
  private readonly snapshotPath: string;

  constructor(
    private readonly agentDir: string,
    initialSnapshot?: StateSnapshot
  ) {
    this.snapshotPath = path.join(agentDir, SNAPSHOT_FILENAME);
    this.snapshot = initialSnapshot ?? createSnapshot();
  }

  /** Load snapshot from disk. Returns null if no snapshot exists. */
  async load(): Promise<StateSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapshotPath, 'utf-8');
      this.snapshot = JSON.parse(raw) as StateSnapshot;
      return this.snapshot;
    } catch {
      return null;
    }
  }

  /** Save current snapshot to disk. */
  async save(): Promise<void> {
    this.snapshot.timestamp = new Date().toISOString();
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, JSON.stringify(this.snapshot, null, 2), 'utf-8');
  }

  get current(): StateSnapshot {
    return this.snapshot;
  }

  /** Update branch and commit info. */
  setBranchInfo(branch: string, lastCommit: string): void {
    this.snapshot.branch = branch;
    this.snapshot.lastCommit = lastCommit;
  }

  /** Record a decision made during the session. */
  addDecision(entry: Omit<DecisionEntry, 'timestamp'>): void {
    this.snapshot.sessionKnowledge.decisions.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  /** Record a key file/location discovered during exploration. */
  addKeyLocation(loc: Omit<KeyLocation, 'discoveredAt'>): void {
    this.snapshot.sessionKnowledge.keyLocations.push({
      ...loc,
      discoveredAt: new Date().toISOString(),
    });
  }

  /** Record a dead end to avoid re-exploring in future sessions. */
  addDeadEnd(deadEnd: Omit<DeadEnd, 'discoveredAt'>): void {
    this.snapshot.sessionKnowledge.deadEnds.push({
      ...deadEnd,
      discoveredAt: new Date().toISOString(),
    });
  }

  /** Update the list of active task IDs. */
  setActiveTasks(taskIds: string[]): void {
    this.snapshot.activeTasks = taskIds;
  }

  /** Record a file modification. */
  recordFileModified(filePath: string): void {
    if (!this.snapshot.modifiedFiles.includes(filePath)) {
      this.snapshot.modifiedFiles.push(filePath);
    }
    if (!this.snapshot.sessionFriction.uniqueFilesModified.includes(filePath)) {
      this.snapshot.sessionFriction.uniqueFilesModified.push(filePath);
    }
    this.snapshot.sessionFriction.mutationsSinceTest++;
    this.snapshot.sessionFriction.totalMutations++;
  }

  /** Record that a test cycle was run. Resets mutationsSinceTest. */
  recordTestRun(): void {
    this.snapshot.sessionFriction.testCycles++;
    this.snapshot.sessionFriction.mutationsSinceTest = 0;
  }
}
