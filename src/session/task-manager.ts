/**
 * Task Manager — ownership, dependency resolution, and lifecycle.
 *
 * Replicates THE_FACTORY's task queue pattern where tasks are claimed
 * before work starts, dependencies gate readiness, and completion
 * requires a run record.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Task, TaskPriority, TaskStatus } from './types.js';

const TASKS_FILENAME = 'tasks.jsonl';

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private readonly tasksPath: string;

  constructor(private readonly agentDir: string) {
    this.tasksPath = path.join(agentDir, TASKS_FILENAME);
  }

  /** Load all tasks from .agent/tasks.jsonl. */
  async load(): Promise<Task[]> {
    this.tasks.clear();
    try {
      const raw = await fs.readFile(this.tasksPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const task = JSON.parse(line) as Task;
        this.tasks.set(task.id, task);
      }
    } catch {
      // No tasks file yet — start empty.
    }
    return this.all();
  }

  /** Persist all tasks back to disk. */
  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.tasksPath), { recursive: true });
    const lines = Array.from(this.tasks.values()).map(t => JSON.stringify(t));
    await fs.writeFile(this.tasksPath, lines.join('\n') + '\n', 'utf-8');
  }

  /** Get all tasks as an array. */
  all(): Task[] {
    return Array.from(this.tasks.values());
  }

  /** Get a task by ID. */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Add a task. */
  add(task: Task): void {
    this.tasks.set(task.id, task);
  }

  /** Update a task's fields. */
  update(id: string, updates: Partial<Omit<Task, 'id'>>): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    return task;
  }

  /**
   * Resolve dependencies and return the next claimable task, sorted by priority.
   *
   * A task is "ready" when:
   * 1. status is 'pending' (not in_progress, complete, blocked, or skipped)
   * 2. All tasks in its blockedBy list have status 'complete'
   *
   * Returns tasks sorted by priority (critical > high > medium > low),
   * with ties broken by creation order.
   */
  ready(): Task[] {
    const completedIds = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.status === 'complete') {
        completedIds.add(task.id);
      }
    }

    const readyTasks: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      const allDepsComplete = task.blockedBy.every(dep => completedIds.has(dep));
      if (allDepsComplete) {
        readyTasks.push(task);
      }
    }

    readyTasks.sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return readyTasks;
  }

  /**
   * Claim a task for execution. Sets status to 'in_progress' and
   * assigns it to the given agent/session ID.
   */
  claim(taskId: string, assignee: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== 'pending') {
      throw new Error(`Task ${taskId} is not pending (status: ${task.status})`);
    }
    task.status = 'in_progress';
    task.assignedTo = assignee;
    task.updatedAt = new Date().toISOString();
    return task;
  }

  /**
   * Complete a task. Requires that a run record ID be provided
   * to enforce the "no close without run record" rule.
   */
  complete(taskId: string, runRecordId: string): Task {
    if (!runRecordId) {
      throw new Error('Run record ID required to complete a task');
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.status = 'complete';
    task.updatedAt = new Date().toISOString();
    return task;
  }

  /** Check for tasks that are blocked by incomplete dependencies. */
  blocked(): Task[] {
    const completedIds = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.status === 'complete') {
        completedIds.add(task.id);
      }
    }

    return this.all().filter(task => {
      if (task.status !== 'pending' && task.status !== 'blocked') return false;
      return task.blockedBy.some(dep => !completedIds.has(dep));
    });
  }
}
