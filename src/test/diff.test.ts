import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateRunDiff, initSeedRepo } from '../engine/diff.js';

describe('generateRunDiff', () => {
  let workDir: string;
  let runId: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crucible-diff-test-'));
    runId = 'test-diff-' + Date.now();

    // Ensure the runs dir exists for output
    await fs.mkdir(path.join('runs', runId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(path.join('runs', runId), { recursive: true, force: true }).catch(() => {});
  });

  it('returns null when no workDir is provided', async () => {
    const result = await generateRunDiff(runId);
    assert.equal(result, null);
  });

  it('returns null when no changes since seed commit', async () => {
    await fs.writeFile(path.join(workDir, 'hello.txt'), 'hello');
    await initSeedRepo(workDir);
    // No changes after seed commit
    const result = await generateRunDiff(runId, workDir);
    assert.equal(result, null);
  });

  it('generates diff for a modified file', async () => {
    await fs.writeFile(path.join(workDir, 'app.ts'), 'const x = 1;\n');
    await initSeedRepo(workDir);

    // Simulate agent modifying the file
    await fs.writeFile(path.join(workDir, 'app.ts'), 'const x = 2;\nconst y = 3;\n');

    const result = await generateRunDiff(runId, workDir);
    assert.ok(result, 'should return a DiffResult');
    assert.equal(result.stats.filesChanged, 1);
    assert.ok(result.stats.insertions > 0);
    assert.equal(result.stats.files[0].path, 'app.ts');
    assert.equal(result.stats.files[0].status, 'modified');

    // Verify patch file was written
    const patchContent = await fs.readFile(result.patchPath, 'utf-8');
    assert.ok(patchContent.includes('+const x = 2;'));
  });

  it('detects new files (not in seed)', async () => {
    await fs.writeFile(path.join(workDir, 'existing.ts'), 'old\n');
    await initSeedRepo(workDir);

    // Agent creates a new file
    await fs.writeFile(path.join(workDir, 'newfile.ts'), 'export const NEW = true;\n');

    const result = await generateRunDiff(runId, workDir);
    assert.ok(result);
    assert.equal(result.stats.filesChanged, 1);
    assert.equal(result.stats.files[0].path, 'newfile.ts');
    assert.equal(result.stats.files[0].status, 'added');
    assert.ok(result.stats.insertions > 0);
  });

  it('handles multiple files', async () => {
    await fs.writeFile(path.join(workDir, 'a.ts'), 'line1\n');
    await fs.writeFile(path.join(workDir, 'b.ts'), 'old\n');
    await initSeedRepo(workDir);

    // Agent modifies a.ts, b.ts, and creates c.ts
    await fs.writeFile(path.join(workDir, 'a.ts'), 'line1\nline2\n');
    await fs.writeFile(path.join(workDir, 'b.ts'), 'new\n');
    await fs.writeFile(path.join(workDir, 'c.ts'), 'brand new\n');

    const result = await generateRunDiff(runId, workDir);
    assert.ok(result);
    assert.equal(result.stats.filesChanged, 3);

    const fileNames = result.stats.files.map(f => f.path).sort();
    assert.deepEqual(fileNames, ['a.ts', 'b.ts', 'c.ts']);
  });

  it('handles subdirectories', async () => {
    await fs.mkdir(path.join(workDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'src/index.ts'), 'old\n');
    await initSeedRepo(workDir);

    await fs.writeFile(path.join(workDir, 'src/index.ts'), 'new\n');

    const result = await generateRunDiff(runId, workDir);
    assert.ok(result);
    assert.equal(result.stats.filesChanged, 1);
    assert.equal(result.stats.files[0].path, 'src/index.ts');
  });

  it('accepts raw patch content (Docker path)', async () => {
    const fakePatch = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
`;

    const result = await generateRunDiff(runId, undefined, fakePatch);
    assert.ok(result);
    assert.equal(result.stats.filesChanged, 1);
    assert.equal(result.stats.files[0].path, 'foo.ts');
    assert.equal(result.stats.files[0].insertions, 1);
    assert.equal(result.stats.files[0].status, 'modified');
  });

  it('detects deleted files', async () => {
    const fakePatch = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const x = 1;
-const y = 2;
`;

    const result = await generateRunDiff(runId, undefined, fakePatch);
    assert.ok(result);
    assert.equal(result.stats.files[0].status, 'deleted');
    assert.equal(result.stats.files[0].deletions, 2);
  });

  it('returns null for empty patch content', async () => {
    const result = await generateRunDiff(runId, undefined, '');
    assert.equal(result, null);
  });
});

describe('initSeedRepo', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crucible-seed-test-'));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('creates a git repo with a seed commit', async () => {
    await fs.writeFile(path.join(workDir, 'test.txt'), 'hello');
    await initSeedRepo(workDir);

    // Verify .git exists
    const gitDir = await fs.stat(path.join(workDir, '.git'));
    assert.ok(gitDir.isDirectory());

    // Verify there's exactly one commit
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: workDir });
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('seed'));
  });
});
