import { Sandbox } from 'e2b';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunConfig, ToolContext, ExecResult, ArtifactManifest } from '../types/index.js';

/**
 * Working directory inside the E2B sandbox.
 * All agent-produced files are expected to live here.
 */
const SANDBOX_WORKDIR = '/home/user';

/**
 * Manages the lifecycle of a single E2B sandbox and exposes a ToolContext
 * facade for agent tool actions. Each instance is independent — no cross-run
 * state. Use SandboxRunner.create() to instantiate.
 */
export class SandboxRunner {
  private sandbox: Sandbox;
  private destroyed = false;

  private constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Create a new E2B sandbox configured for the given run.
   *
   * TTL is set to config.ttlSeconds + 30 to give the application-level
   * teardown (at config.ttlSeconds) time to flush artifacts before E2B's
   * hard backstop fires.
   *
   * Network outbound is disabled by default. If taskPayload.networkAllowlist
   * contains any entries, internet access is enabled. Note: the E2B SDK v1
   * exposes a boolean toggle only (allowInternetAccess) — per-host allowlist
   * enforcement is not available at the SDK level and would require a custom
   * sandbox template with firewall rules.
   */
  static async create(config: RunConfig): Promise<SandboxRunner> {
    const ttlMs = (config.ttlSeconds + 30) * 1000;

    const allowlist = config.taskPayload.networkAllowlist ?? [];
    const allowInternetAccess = allowlist.length > 0;

    const sandbox = await Sandbox.create({
      timeoutMs: ttlMs,
      allowInternetAccess,
    });

    // If there are initial files in the task payload, upload them now.
    const initialFiles = config.taskPayload.files;
    if (initialFiles !== undefined) {
      const entries = Object.entries(initialFiles);
      if (entries.length > 0) {
        await Promise.all(
          entries.map(async ([filePath, content]) => {
            const sandboxPath = filePath.startsWith('/')
              ? filePath
              : `${SANDBOX_WORKDIR}/${filePath}`;
            await sandbox.files.write(sandboxPath, content);
          })
        );
      }
    }

    // Upload seedDir contents to sandbox if specified
    if (config.taskPayload.seedDir) {
      await SandboxRunner.uploadSeedDir(sandbox, config.taskPayload.seedDir);
    }

    return new SandboxRunner(sandbox);
  }

  /**
   * Upload a local directory tree to the sandbox.
   * Skips common heavy/irrelevant directories (node_modules, .git, dist, etc.).
   * Files are uploaded relative to SANDBOX_WORKDIR.
   */
  private static async uploadSeedDir(sandbox: Sandbox, seedDirPath: string): Promise<void> {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'venv', '.cache', 'runs', 'data']);
    const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip large binary files

    async function walkDir(dirPath: string, relativeTo: string): Promise<Array<{ relative: string; absolute: string }>> {
      const results: Array<{ relative: string; absolute: string }> = [];
      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        return results;
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(relativeTo, fullPath);

        if (entry.isDirectory()) {
          const children = await walkDir(fullPath, relativeTo);
          results.push(...children);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size <= MAX_FILE_SIZE) {
              results.push({ relative: relPath, absolute: fullPath });
            }
          } catch {
            // Skip files we can't stat
          }
        }
      }
      return results;
    }

    const files = await walkDir(seedDirPath, seedDirPath);

    // Upload in batches of 10 for concurrency control
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (file) => {
          try {
            const content = await fs.readFile(file.absolute, 'utf-8');
            const sandboxPath = `${SANDBOX_WORKDIR}/${file.relative}`;
            await sandbox.files.write(sandboxPath, content);
          } catch {
            // Skip files that can't be read as UTF-8 (binary files)
          }
        })
      );
    }
  }

  /**
   * Return a ToolContext facade backed by this sandbox.
   * The agent receives this object — it never holds a reference to the
   * sandbox or the runner directly.
   */
  getToolContext(): ToolContext {
    return {
      exec: async (cmd: string): Promise<ExecResult> => {
        const result = await this.sandbox.commands.run(cmd, {
          cwd: SANDBOX_WORKDIR,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },

      writeFile: async (filePath: string, content: string): Promise<void> => {
        const sandboxPath = filePath.startsWith('/')
          ? filePath
          : `${SANDBOX_WORKDIR}/${filePath}`;
        await this.sandbox.files.write(sandboxPath, content);
      },

      readFile: async (filePath: string): Promise<string> => {
        const sandboxPath = filePath.startsWith('/')
          ? filePath
          : `${SANDBOX_WORKDIR}/${filePath}`;
        return this.sandbox.files.read(sandboxPath);
      },
    };
  }

  /**
   * Download all files from the sandbox working directory to
   * ./runs/<runId>/artifacts/ on the host.
   *
   * Files are listed recursively (depth: 100 covers all practical cases).
   * Directories are skipped — only files are downloaded.
   *
   * Artifact flush MUST complete before destroy() is called. The caller
   * (teardown) is responsible for this ordering.
   *
   * @returns ArtifactManifest listing every downloaded file and its size.
   */
  async flushArtifacts(runId: string): Promise<ArtifactManifest> {
    const outputDir = path.join('runs', runId, 'artifacts');
    await fs.mkdir(outputDir, { recursive: true });

    const entries = await this.sandbox.files.list(SANDBOX_WORKDIR, {
      depth: 100,
    });

    const manifest: ArtifactManifest = {
      outputDir,
      files: [],
    };

    for (const entry of entries) {
      // Skip directories — only download files.
      if (entry.type === 'dir') {
        continue;
      }

      const content = await this.sandbox.files.read(entry.path, {
        format: 'bytes',
      });

      // Compute host path by stripping the sandbox workdir prefix.
      const relativePath = entry.path.startsWith(SANDBOX_WORKDIR + '/')
        ? entry.path.slice(SANDBOX_WORKDIR.length + 1)
        : entry.path.replace(/^\//, '');

      const hostPath = path.join(outputDir, relativePath);
      await fs.mkdir(path.dirname(hostPath), { recursive: true });
      await fs.writeFile(hostPath, content);

      manifest.files.push({
        path: hostPath,
        sizeBytes: content.byteLength,
      });
    }

    return manifest;
  }

  /**
   * Kill the E2B sandbox and mark this runner as destroyed.
   * Idempotent — safe to call multiple times.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    await this.sandbox.kill();
  }
}
