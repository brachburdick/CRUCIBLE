import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Projects API — aggregates tasks, questions, and context from ALL projects
 * under the THE_FACTORY/projects/ directory.
 *
 * Supports nested project structures (e.g. DjTools/scue, DjTools/accumulate).
 * A directory is a "project" if it has .agent/tasks.jsonl or CLAUDE.md.
 * A directory is a "group" if it contains subdirectories that are projects.
 */

interface ProjectInfo {
  name: string;
  displayName: string;       // e.g. "DjTools/scue"
  path: string;
  hasClaudeMd: boolean;
  taskCount: number;
  pendingTaskCount: number;
  pendingQuestionCount: number;
  isGroup: boolean;          // true = container with children, not a project itself
  children: ProjectInfo[];
}

interface ProjectTask {
  project: string;
  projectPath: string;
  id: string;
  description?: string;
  summary?: string;
  taskType?: string;
  status: string;
  priority?: string;
  riskLevel?: string;
  blockedBy?: string[];
  flowPhase?: string;
  [key: string]: unknown;
}

interface ProjectQuestion {
  project: string;
  id: string;
  task: string;
  question: string;
  options: string[];
  status: string;
  [key: string]: unknown;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', '.venv', '__pycache__', '.next',
  '.agent', '.claude', 'runs', 'data', 'schemas', 'public', 'build',
]);

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively discover projects. A directory is a project if it has
 * .agent/tasks.jsonl or CLAUDE.md. If it has neither but contains
 * subdirectories that ARE projects, it's a group.
 */
async function discoverProjects(dir: string, prefix: string = ''): Promise<ProjectInfo[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: ProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);
    const displayName = prefix ? `${prefix}/${entry.name}` : entry.name;

    const hasTasksFile = await fileExists(path.join(fullPath, '.agent', 'tasks.jsonl'));
    const hasClaudeMd = await fileExists(path.join(fullPath, 'CLAUDE.md'));
    const isProject = hasTasksFile || hasClaudeMd;

    if (isProject) {
      // This is a leaf project
      const tasks = await readJsonl<Record<string, unknown>>(path.join(fullPath, '.agent', 'tasks.jsonl'));
      const questions = await readJsonl<Record<string, unknown>>(path.join(fullPath, '.agent', 'questions.jsonl'));

      results.push({
        name: displayName,
        displayName,
        path: fullPath,
        hasClaudeMd,
        taskCount: tasks.length,
        pendingTaskCount: tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length,
        pendingQuestionCount: questions.filter(q => q.status === 'pending').length,
        isGroup: false,
        children: [],
      });
    } else {
      // Check if it's a group (contains project subdirectories)
      const children = await discoverProjects(fullPath, displayName);
      if (children.length > 0) {
        const totalTasks = children.reduce((sum, c) => sum + c.taskCount, 0);
        const totalPending = children.reduce((sum, c) => sum + c.pendingTaskCount, 0);
        const totalQuestions = children.reduce((sum, c) => sum + c.pendingQuestionCount, 0);

        results.push({
          name: entry.name,
          displayName,
          path: fullPath,
          hasClaudeMd: false,
          taskCount: totalTasks,
          pendingTaskCount: totalPending,
          pendingQuestionCount: totalQuestions,
          isGroup: true,
          children,
        });
      }
    }
  }

  // Sort: groups first, then by pending count, then alphabetical
  results.sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    return b.pendingTaskCount - a.pendingTaskCount || a.name.localeCompare(b.name);
  });

  return results;
}

/** Flatten a project tree into a list of leaf projects. */
function flattenProjects(projects: ProjectInfo[]): ProjectInfo[] {
  const result: ProjectInfo[] = [];
  for (const p of projects) {
    if (p.isGroup) {
      result.push(...flattenProjects(p.children));
    } else {
      result.push(p);
    }
  }
  return result;
}

export function registerProjectRoutes(app: FastifyInstance, projectsDir: string): void {

  // ── List all projects (tree structure) ──────────────────────────────
  app.get('/api/projects', async () => {
    return discoverProjects(projectsDir);
  });

  // ── Aggregated tasks across ALL projects ────────────────────────────
  app.get<{
    Querystring: { status?: string; project?: string };
  }>('/api/projects/tasks', async (request) => {
    const { status, project } = request.query;
    const tree = await discoverProjects(projectsDir);
    const allProjects = flattenProjects(tree);
    const allTasks: ProjectTask[] = [];

    for (const p of allProjects) {
      if (project && p.name !== project) continue;

      const tasksPath = path.join(p.path, '.agent', 'tasks.jsonl');
      const tasks = await readJsonl<Record<string, unknown>>(tasksPath);

      for (const task of tasks) {
        const t: ProjectTask = {
          project: p.name,
          projectPath: p.path,
          id: task.id as string,
          description: (task.description ?? task.summary) as string | undefined,
          summary: task.summary as string | undefined,
          taskType: task.taskType as string | undefined,
          status: task.status as string,
          priority: task.priority as string | undefined,
          riskLevel: task.riskLevel as string | undefined,
          blockedBy: task.blockedBy as string[] | undefined,
          flowPhase: task.flowPhase as string | undefined,
        };

        if (!status || t.status === status) {
          allTasks.push(t);
        }
      }
    }

    return allTasks;
  });

  // ── Aggregated pending questions across ALL projects ─────────────────
  app.get('/api/projects/questions', async () => {
    const tree = await discoverProjects(projectsDir);
    const allProjects = flattenProjects(tree);
    const allQuestions: ProjectQuestion[] = [];

    for (const p of allProjects) {
      const questionsPath = path.join(p.path, '.agent', 'questions.jsonl');
      const questions = await readJsonl<Record<string, unknown>>(questionsPath);

      for (const q of questions) {
        if (q.status === 'pending') {
          allQuestions.push({
            project: p.name,
            id: q.id as string,
            task: q.task as string,
            question: q.question as string,
            options: q.options as string[],
            status: q.status as string,
            default: q.default as string,
            impact: q.impact as string,
          });
        }
      }
    }

    return allQuestions;
  });

  // ── Get a project's CLAUDE.md — supports nested paths (e.g. DjTools/scue) ──
  app.get<{
    Params: { '*': string };
  }>('/api/projects/context/*', async (request, reply) => {
    const projectPath = path.join(projectsDir, request.params['*']);
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');

    try {
      const content = await fs.readFile(claudeMdPath, 'utf-8');
      return { project: request.params['*'], claudeMd: content };
    } catch {
      return reply.code(404).send({ error: 'CLAUDE.md not found for this project' });
    }
  });

  // ── Get a project's tasks — supports nested paths ────────────────────
  app.get<{
    Params: { '*': string };
  }>('/api/projects/tasks-for/*', async (request) => {
    const tasksPath = path.join(projectsDir, request.params['*'], '.agent', 'tasks.jsonl');
    return readJsonl(tasksPath);
  });
}
