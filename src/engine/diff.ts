import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DiffFileStats {
  path: string;
  insertions: number;
  deletions: number;
  status: 'modified' | 'added' | 'deleted';
}

export interface DiffResult {
  patchPath: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: DiffFileStats[];
  };
}

/**
 * Initialize a git repo in a workdir and commit all files as the seed baseline.
 * Call this after seeding files but before launching the agent.
 * The agent doesn't need to know about git — it's harness infrastructure.
 */
export async function initSeedRepo(workDir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await execFileAsync('git', ['add', '-A'], { cwd: workDir });
  await execFileAsync('git', [
    '-c', 'user.name=crucible',
    '-c', 'user.email=crucible@harness',
    'commit', '-q', '-m', 'seed', '--allow-empty',
  ], { cwd: workDir });
}

/**
 * Generate a unified diff of all changes since the seed commit.
 * Runs `git diff HEAD` in the workdir — captures everything the agent changed.
 *
 * For Docker containers, pass the raw patch string via `patchContent` instead
 * (obtained via `docker exec git diff HEAD` before container destroy).
 *
 * Returns null if there are no changes.
 */
export async function generateRunDiff(
  runId: string,
  workDir?: string,
  patchContent?: string,
): Promise<DiffResult | null> {
  let patch: string;

  if (patchContent !== undefined) {
    // Docker/remote path: patch already captured from container
    patch = patchContent;
  } else if (workDir) {
    // Local path: run git diff in the workdir
    try {
      // Include untracked files by adding them first
      await execFileAsync('git', ['add', '-A'], { cwd: workDir });
      const { stdout } = await execFileAsync('git', [
        'diff', '--cached', 'HEAD',
      ], { cwd: workDir, maxBuffer: 10 * 1024 * 1024 });
      patch = stdout;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!patch.trim()) return null;

  // Parse stats from the patch
  const files = parsePatchFiles(patch);

  // Write the patch file
  const runDir = path.join('runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  const patchPath = path.join(runDir, 'diff.patch');
  await fs.writeFile(patchPath, patch, 'utf-8');

  const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    patchPath,
    stats: {
      filesChanged: files.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
      files,
    },
  };
}

/** Parse per-file stats from a unified diff patch string. */
function parsePatchFiles(patch: string): DiffFileStats[] {
  const files: DiffFileStats[] = [];
  let currentFile: string | null = null;
  let currentInsertions = 0;
  let currentDeletions = 0;
  let isNewFile = false;
  let isDeletedFile = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      // Flush previous file
      if (currentFile) {
        files.push({
          path: currentFile,
          insertions: currentInsertions,
          deletions: currentDeletions,
          status: isNewFile ? 'added' : isDeletedFile ? 'deleted' : 'modified',
        });
      }
      // Parse file path from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      currentFile = match ? match[2] : null;
      currentInsertions = 0;
      currentDeletions = 0;
      isNewFile = false;
      isDeletedFile = false;
    } else if (line.startsWith('new file mode')) {
      isNewFile = true;
    } else if (line.startsWith('deleted file mode')) {
      isDeletedFile = true;
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
      status: isNewFile ? 'added' : isDeletedFile ? 'deleted' : 'modified',
    });
  }

  return files;
}
