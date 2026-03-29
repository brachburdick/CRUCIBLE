import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getRun, markRunApplied } from '../db.js';

const execFileAsync = promisify(execFile);

export function registerArtifactRoutes(app: FastifyInstance, db: Database.Database): void {
  // ── GET /api/runs/:id/diff — return patch content + stats ──────────────
  app.get<{ Params: { id: string } }>('/api/runs/:id/diff', async (request, reply) => {
    const run = getRun(db, request.params.id);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const patchPath = path.join('runs', request.params.id, 'diff.patch');
    let patch: string;
    try {
      patch = await fs.readFile(patchPath, 'utf-8');
    } catch {
      return reply.code(404).send({ error: 'No diff available' });
    }

    // Parse stats from the result.json if available, otherwise compute from patch
    const stats = parsePatchStats(patch);

    return {
      patch,
      stats,
      applied: !!run.applied_at,
      appliedAt: run.applied_at,
      appliedMode: run.applied_mode,
    };
  });

  // ── POST /api/runs/:id/apply — git apply the patch ─────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      mode?: 'working-tree' | 'branch' | 'commit';
      commitMessage?: string;
    };
  }>('/api/runs/:id/apply', async (request, reply) => {
    const run = getRun(db, request.params.id);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.applied_at) {
      return reply.code(400).send({ error: 'Already applied' });
    }

    // Parse task JSON to get seedDir
    let taskData: Record<string, unknown>;
    try {
      taskData = JSON.parse(run.task_json);
    } catch {
      return reply.code(400).send({ error: 'Invalid task data' });
    }

    const seedDir = taskData['seedDir'] as string | undefined;
    if (!seedDir) {
      return reply.code(400).send({ error: 'No seedDir on this run' });
    }

    // Path traversal protection: validate seedDir is a real directory
    const resolvedSeedDir = path.resolve(seedDir);
    try {
      const stat = await fs.stat(resolvedSeedDir);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'seedDir is not a directory' });
      }
    } catch {
      return reply.code(400).send({ error: 'seedDir does not exist' });
    }

    // Read the patch
    const patchPath = path.resolve(path.join('runs', request.params.id, 'diff.patch'));
    let patch: string;
    try {
      patch = await fs.readFile(patchPath, 'utf-8');
    } catch {
      return reply.code(400).send({ error: 'No diff available' });
    }

    const mode = request.body?.mode ?? 'working-tree';
    const runIdShort = request.params.id.slice(0, 8);

    try {
      if (mode === 'branch') {
        // Create a new branch and apply there
        const branchName = `crucible/${runIdShort}`;
        await execFileAsync('git', ['checkout', '-b', branchName], { cwd: resolvedSeedDir });

        try {
          await execFileAsync('git', ['apply', '--stat', '--apply', patchPath], { cwd: resolvedSeedDir });
        } catch (err) {
          // Rollback branch on failure
          await execFileAsync('git', ['checkout', '-'], { cwd: resolvedSeedDir }).catch(() => {});
          await execFileAsync('git', ['branch', '-D', branchName], { cwd: resolvedSeedDir }).catch(() => {});
          return handleApplyError(reply, err);
        }

        markRunApplied(db, request.params.id, mode);
        return { applied: true, mode, branch: branchName };
      }

      if (mode === 'commit') {
        // Apply and commit
        await execFileAsync('git', ['apply', '--stat', '--apply', patchPath], { cwd: resolvedSeedDir })
          .catch((err) => { throw err; });

        // Stage all changes
        await execFileAsync('git', ['add', '-A'], { cwd: resolvedSeedDir });

        const message = request.body?.commitMessage
          ?? `crucible: apply run ${runIdShort} (${run.variant})`;

        const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd: resolvedSeedDir });

        // Get the commit hash
        const { stdout: hash } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: resolvedSeedDir });

        markRunApplied(db, request.params.id, mode);
        return { applied: true, mode, commitHash: hash.trim() };
      }

      // Default: working-tree
      await execFileAsync('git', ['apply', '--stat', '--apply', patchPath], { cwd: resolvedSeedDir });

      markRunApplied(db, request.params.id, mode);
      return { applied: true, mode };

    } catch (err) {
      return handleApplyError(reply, err);
    }
  });
}

function handleApplyError(reply: any, err: unknown): any {
  const execErr = err as { stderr?: string; stdout?: string };
  const stderr = execErr.stderr ?? '';

  // Check for conflict
  if (stderr.includes('patch does not apply') || stderr.includes('already exists') || stderr.includes('conflict')) {
    // Try to extract conflicting file names
    const conflicts = stderr.split('\n')
      .filter(line => line.includes('error:'))
      .map(line => line.replace(/^error:\s*/, '').trim());

    return reply.code(409).send({
      error: 'Conflicts detected',
      conflicts: conflicts.length > 0 ? conflicts : [stderr.trim()],
    });
  }

  return reply.code(500).send({
    error: 'Apply failed',
    detail: stderr || (err instanceof Error ? err.message : String(err)),
  });
}

/** Parse stats from a unified diff patch string. */
function parsePatchStats(patch: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; insertions: number; deletions: number; status: string }>;
} {
  const files: Array<{ path: string; insertions: number; deletions: number; status: string }> = [];
  let currentFile: string | null = null;
  let currentInsertions = 0;
  let currentDeletions = 0;
  let isNewFile = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      // Flush previous file
      if (currentFile) {
        files.push({
          path: currentFile,
          insertions: currentInsertions,
          deletions: currentDeletions,
          status: isNewFile ? 'added' : 'modified',
        });
      }
      // Parse file path from "diff --git a/path b/path"
      const match = line.match(/diff --git\s+(?:a\/)?(\S+)\s+(?:b\/)?(\S+)/);
      currentFile = match ? match[2] : null;
      currentInsertions = 0;
      currentDeletions = 0;
      isNewFile = false;
    } else if (line.startsWith('--- /dev/null')) {
      isNewFile = true;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      currentInsertions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentDeletions++;
    }
  }

  // Flush last file
  if (currentFile) {
    files.push({
      path: currentFile,
      insertions: currentInsertions,
      deletions: currentDeletions,
      status: isNewFile ? 'added' : 'modified',
    });
  }

  const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    filesChanged: files.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    files,
  };
}
