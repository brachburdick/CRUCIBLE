import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  TaskPayload,
  CheckSpec,
  ScoreResult,
  ArtifactManifest,
  OnTurnCallback,
} from '../types/index.js';
import { DockerNotAvailableError } from '../types/index.js';
import { parseCliStream, type CliAgentResult } from '../agents/cli-runner.js';
import { resolveImageTag } from './runtime-detect.js';

const DEFAULT_IMAGE_TAG = 'crucible-runner:base';
const BASE_IMAGE_TAG = 'crucible-runner:base';
const CONTAINER_WORKDIR = '/workspace';
const CLAUDE_HOME = path.join(os.homedir(), '.claude');

// ─── Configuration ───

export interface DockerRunnerConfig {
  /** Unique run ID for labeling and artifact paths */
  runId: string;
  /** Task payload with files, seedDir, networkAllowlist */
  taskPayload: TaskPayload;
  /** Wall-clock TTL in seconds */
  ttlSeconds: number;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Model alias or full name */
  model?: string;
  /** Max agentic turns */
  maxTurns?: number;
  /** Max budget in USD */
  maxBudgetUsd?: number;
  /** Allowed tools */
  allowedTools?: string[];
  /** Disallowed tools */
  disallowedTools?: string[];
  /** Extra CLI flags */
  extraFlags?: string[];
  /** Per-turn event callback */
  onTurn?: OnTurnCallback;
  /** Docker image tag (default: crucible-runner:latest) */
  imageTag?: string;
  /** Path to directory containing Dockerfile (default: ./docker) */
  dockerfilePath?: string;
  /** Memory limit (default: 4g) */
  memoryLimit?: string;
  /** CPU limit (default: 2) */
  cpuLimit?: number;
}

// ─── DockerRunner ───

/**
 * Manages the lifecycle of a Docker container running the Claude CLI.
 *
 * Provides E2B-equivalent isolation while using Claude Code subscription auth:
 *   - Full process isolation (container boundary)
 *   - Filesystem isolation (/workspace/ seeded with task files)
 *   - Network isolation (iptables allowlist in entrypoint)
 *   - Resource limits (memory + CPU caps)
 *   - Auth via read-only mount of ~/.claude/
 *
 * Lifecycle: create() → run() → runChecks() → flushArtifacts() → destroy()
 */
export class DockerRunner {
  private containerId: string;
  private destroyed = false;
  private ttlTimer: NodeJS.Timeout | null = null;
  private activeProc: ChildProcess | null = null;

  private constructor(containerId: string) {
    this.containerId = containerId;
  }

  // ─── Factory ───

  /**
   * Create a Docker container, seed it with task files, and return a runner.
   *
   * 1. Verifies Docker daemon is available
   * 2. Ensures the crucible-runner image exists (builds if missing)
   * 3. Creates + starts a container (sleeping, waiting for docker exec)
   * 4. Seeds task files into /workspace/ via docker cp
   */
  static async create(config: DockerRunnerConfig): Promise<DockerRunner> {
    await DockerRunner.verifyDocker();

    // Resolve image: explicit imageTag > task payload detection > base
    const imageTag = config.imageTag ?? resolveImageTag(config.taskPayload);
    const dockerfilePath = config.dockerfilePath ?? path.join(process.cwd(), 'docker');
    await DockerRunner.ensureImage(imageTag, dockerfilePath);

    const runner = new DockerRunner('');

    // Create the container
    const containerId = await runner.createContainer(config, imageTag);
    runner.containerId = containerId;

    // Start it (entrypoint runs, then sleeps)
    DockerRunner.exec('docker', ['start', containerId]);

    // Seed files
    await runner.seedFiles(config);

    return runner;
  }

  // ─── Run agent ───

  /**
   * Execute `claude -p` inside the container.
   * Pipes stdout back to the host for stream-json parsing.
   * Reuses parseCliStream() from cli-runner.ts.
   */
  async run(config: DockerRunnerConfig): Promise<CliAgentResult> {
    const args = this.buildClaudeArgs(config);

    // Spawn docker exec as agent user in /workspace (root triggers Claude CLI permission error)
    const proc = spawn('docker', [
      'exec', '-i', '-u', 'agent', '-w', CONTAINER_WORKDIR,
      this.containerId,
      'claude',
      ...args,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.activeProc = proc;

    // Pipe prompt via stdin
    const prompt = `Task: ${config.taskPayload.description}\n\nInstructions:\n${config.taskPayload.instructions}`;
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // TTL enforcement: stop the container after timeout
    let killedByTtl = false;
    if (config.ttlSeconds > 0) {
      this.ttlTimer = setTimeout(() => {
        killedByTtl = true;
        // Stop the container gracefully (5s grace), then force
        spawn('docker', ['stop', '-t', '5', this.containerId], { stdio: 'ignore' });
      }, config.ttlSeconds * 1000);
      this.ttlTimer.unref();
    }

    // Parse the stream-json output (reuses cli-runner.ts logic)
    const result = await parseCliStream(proc, config.onTurn);

    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.activeProc = null;

    if (killedByTtl) {
      result.killReason = 'ttl_exceeded';
    }

    return result;
  }

  // ─── Checks ───

  /**
   * Run acceptance checks inside the container.
   * Uses `docker exec` for each check command.
   */
  async runChecks(checks: CheckSpec[]): Promise<ScoreResult> {
    const results = await Promise.all(
      checks.map(async (check) => {
        try {
          const stdout = execSync(
            `docker exec -u agent -w ${CONTAINER_WORKDIR} ${this.containerId} sh -c ${shellEscape(check.command)}`,
            {
              timeout: (check.timeout ?? 30) * 1000,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          return {
            name: check.name,
            passed: true,
            stdout,
            exitCode: 0,
          };
        } catch (err: unknown) {
          const execErr = err as { status?: number; stdout?: string; stderr?: string };
          const exitCode = execErr.status ?? 1;
          return {
            name: check.name,
            passed: exitCode === (check.expectedExitCode ?? 0),
            stdout: execErr.stdout ?? '',
            stderr: execErr.stderr ?? '',
            exitCode,
          };
        }
      }),
    );

    const passRate = results.length > 0
      ? results.filter(c => c.passed).length / results.length
      : 1;

    return { checks: results, passRate };
  }

  // ─── Artifacts ───

  /**
   * Copy /workspace/ contents from container to host.
   * Uses `docker cp` to extract the entire workspace.
   */
  async flushArtifacts(runId: string): Promise<ArtifactManifest> {
    const outputDir = path.join('runs', runId, 'artifacts');
    await fs.mkdir(outputDir, { recursive: true });

    try {
      execSync(
        `docker cp ${this.containerId}:${CONTAINER_WORKDIR}/. ${outputDir}`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      // Container might have no files or workspace might not exist
    }

    // Walk the output dir to build manifest
    const files = await walkFiles(outputDir);
    return {
      outputDir,
      files: files.map(f => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
      })),
    };
  }

  // ─── Cleanup ───

  /**
   * Stop and remove the container. Idempotent — safe to call multiple times.
   * Never throws — errors are logged but swallowed.
   */

  /**
   * Capture `git diff HEAD` from inside the container (Phase 8A).
   * Must be called before destroy(). Returns the raw patch string,
   * or empty string if diff capture fails.
   */
  captureGitDiff(): string {
    if (this.destroyed) return '';
    try {
      // Stage all changes first (including untracked), then diff
      execSync(
        `docker exec -w ${CONTAINER_WORKDIR} ${this.containerId} git add -A`,
        { timeout: 10000, stdio: 'ignore' },
      );
      return execSync(
        `docker exec -w ${CONTAINER_WORKDIR} ${this.containerId} git diff --cached HEAD`,
        { encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch {
      return '';
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }

    try {
      execSync(`docker stop -t 5 ${this.containerId}`, {
        stdio: 'ignore',
        timeout: 15000,
      });
    } catch {
      // Already stopped or doesn't exist
    }

    try {
      execSync(`docker rm -f ${this.containerId}`, {
        stdio: 'ignore',
        timeout: 10000,
      });
    } catch {
      // Already removed
    }
  }

  // ─── Orphan cleanup ───

  /**
   * Find and remove containers labeled as crucible runs that are older than 2 hours.
   * Call at server startup to clean up after crashes.
   */
  static async cleanupOrphans(): Promise<number> {
    let removed = 0;
    try {
      const output = execSync(
        'docker ps -a --filter label=crucible-run-id --format "{{.ID}} {{.Label \\"crucible-created-at\\"}}"',
        { encoding: 'utf-8', timeout: 10000 },
      );

      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        const [id, createdAt] = line.split(' ');
        if (!id || !createdAt) continue;

        const created = new Date(createdAt).getTime();
        if (isNaN(created) || created < twoHoursAgo) {
          try {
            execSync(`docker rm -f ${id}`, { stdio: 'ignore', timeout: 10000 });
            removed++;
          } catch {
            // Best effort
          }
        }
      }
    } catch {
      // Docker not available or no containers — fine
    }
    return removed;
  }

  // ─── Private helpers ───

  /** Verify Docker daemon is reachable. */
  private static async verifyDocker(): Promise<void> {
    try {
      execSync('docker version --format "{{.Server.Version}}"', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new DockerNotAvailableError();
    }
  }

  /** Check if a Docker image exists locally. */
  private static imageExists(tag: string): boolean {
    try {
      execSync(`docker image inspect ${tag}`, {
        stdio: 'ignore',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the requested image exists locally. Builds if missing.
   *
   * For ecosystem images (crucible-runner:<ecosystem>), ensures the base image
   * is built first since ecosystem Dockerfiles use `FROM crucible-runner:base`.
   *
   * Dockerfile naming convention:
   *   crucible-runner:base   → docker/Dockerfile.base (or docker/Dockerfile)
   *   crucible-runner:python → docker/Dockerfile.python
   *   crucible-runner:rust   → docker/Dockerfile.rust
   *   other tags             → docker/Dockerfile (legacy fallback)
   */
  private static async ensureImage(tag: string, dockerfilePath: string): Promise<void> {
    if (DockerRunner.imageExists(tag)) return;

    // Parse ecosystem from tag (e.g., "crucible-runner:python" → "python")
    const ecosystem = tag.startsWith('crucible-runner:')
      ? tag.split(':')[1]
      : null;

    // If this is an ecosystem image (not base), ensure base is built first
    if (ecosystem && ecosystem !== 'base' && ecosystem !== 'latest') {
      if (!DockerRunner.imageExists(BASE_IMAGE_TAG)) {
        const baseDockerfile = DockerRunner.resolveDockerfile(dockerfilePath, 'base');
        execSync(`docker build -t ${BASE_IMAGE_TAG} -f ${baseDockerfile} ${dockerfilePath}`, {
          stdio: 'inherit',
          timeout: 300000,
        });
      }
    }

    // Build the requested image
    const dockerfile = ecosystem
      ? DockerRunner.resolveDockerfile(dockerfilePath, ecosystem)
      : path.join(dockerfilePath, 'Dockerfile');

    execSync(`docker build -t ${tag} -f ${dockerfile} ${dockerfilePath}`, {
      stdio: 'inherit',
      timeout: 600000, // 10 min for ecosystem images (rust is large)
    });
  }

  /**
   * Resolve the Dockerfile path for a given ecosystem.
   * Falls back to the legacy Dockerfile if the ecosystem-specific one doesn't exist.
   */
  private static resolveDockerfile(dockerfilePath: string, ecosystem: string): string {
    const ecosystemFile = path.join(dockerfilePath, `Dockerfile.${ecosystem}`);
    if (fsSync.existsSync(ecosystemFile)) return ecosystemFile;

    // Fallback: legacy Dockerfile (for backward compat)
    const legacyFile = path.join(dockerfilePath, 'Dockerfile');
    if (fsSync.existsSync(legacyFile)) return legacyFile;

    throw new Error(`No Dockerfile found for ecosystem "${ecosystem}" in ${dockerfilePath}`);
  }

  /** Create a container with labels, env, network config. Returns container ID. */
  private async createContainer(config: DockerRunnerConfig, imageTag: string): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 8);
    const containerName = `crucible-${config.runId}-${shortId}`;
    const now = new Date().toISOString();

    const networkAllowlist = (config.taskPayload.networkAllowlist ?? []).join(' ');
    const memoryLimit = config.memoryLimit ?? '4g';
    const cpuLimit = String(config.cpuLimit ?? 2);

    const args = [
      'create',
      '--name', containerName,
      '--label', `crucible-run-id=${config.runId}`,
      '--label', `crucible-created-at=${now}`,
      // Auth: mount ~/.claude/ and ~/.claude.json read-only
      '-v', `${CLAUDE_HOME}:/home/agent/.claude:ro`,
      '-v', `${path.join(os.homedir(), '.claude.json')}:/home/agent/.claude.json:ro`,
      // Auth: pass OAuth token from host environment (subscription-based auth)
      ...(process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? ['-e', `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`]
        : []),
      // Network lockdown allowlist
      '-e', `CRUCIBLE_NETWORK_ALLOWLIST=${networkAllowlist}`,
      // iptables requires NET_ADMIN
      '--cap-add', 'NET_ADMIN',
      // Resource limits
      '--memory', memoryLimit,
      '--cpus', cpuLimit,
      // Image + default command (sleep, waiting for docker exec)
      imageTag,
    ];

    const output = execSync(`docker ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    return output.trim();
  }

  /** Seed task files into /workspace/ via docker cp. */
  private async seedFiles(config: DockerRunnerConfig): Promise<void> {
    // Inline files from taskPayload.files
    if (config.taskPayload.files) {
      // Create a temp dir, write files, docker cp the whole thing
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crucible-seed-'));
      try {
        for (const [filePath, content] of Object.entries(config.taskPayload.files)) {
          const fullPath = path.join(tmpDir, filePath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, 'utf-8');
        }
        execSync(
          `docker cp ${tmpDir}/. ${this.containerId}:${CONTAINER_WORKDIR}/`,
          { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Seed directory
    if (config.taskPayload.seedDir) {
      // Filter out heavy directories, then docker cp
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crucible-seed-'));
      try {
        await copySeedDir(config.taskPayload.seedDir, tmpDir);
        execSync(
          `docker cp ${tmpDir}/. ${this.containerId}:${CONTAINER_WORKDIR}/`,
          { timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Fix ownership (files were copied as root)
    try {
      execSync(
        `docker exec ${this.containerId} chown -R agent:agent ${CONTAINER_WORKDIR}`,
        { timeout: 10000, stdio: 'ignore' },
      );
    } catch {
      // Best effort — entrypoint drops to agent user anyway
    }

    // Init git repo with seed commit for diff generation (Phase 8A)
    try {
      execSync(
        `docker exec -w ${CONTAINER_WORKDIR} ${this.containerId} sh -c "git init -q && git add -A && git -c user.name=crucible -c user.email=crucible@harness commit -q -m seed --allow-empty"`,
        { timeout: 15000, stdio: 'ignore' },
      );
    } catch {
      // Non-fatal — diff generation will be skipped
    }
  }

  /** Build claude CLI arguments. */
  private buildClaudeArgs(config: DockerRunnerConfig): string[] {
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
    ];

    if (config.systemPrompt) {
      args.push('--system-prompt', config.systemPrompt);
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.maxTurns) {
      args.push('--max-turns', String(config.maxTurns));
    }
    if (config.maxBudgetUsd) {
      args.push('--max-budget-usd', String(config.maxBudgetUsd));
    }
    args.push('--permission-mode', 'bypassPermissions');

    if (config.allowedTools && config.allowedTools.length > 0) {
      for (const tool of config.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }
    if (config.disallowedTools && config.disallowedTools.length > 0) {
      for (const tool of config.disallowedTools) {
        args.push('--disallowedTools', tool);
      }
    }
    if (config.extraFlags) {
      args.push(...config.extraFlags);
    }

    // Prompt is piped via stdin in run(), not as a positional argument
    return args;
  }

  /** Synchronous exec helper that returns trimmed output. */
  private static exec(cmd: string, args: string[]): string {
    return execSync(`${cmd} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  }
}

// ─── Utility functions ───

/** Shell-escape a string for use in `sh -c "..."` */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Copy directory tree, skipping heavy/irrelevant dirs. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '__pycache__',
  '.venv', 'venv', '.cache', 'runs', 'data',
]);
const MAX_FILE_SIZE = 512 * 1024; // 512KB

async function copySeedDir(srcDir: string, destDir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copySeedDir(srcPath, destPath);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(srcPath);
        if (stat.size <= MAX_FILE_SIZE) {
          await fs.copyFile(srcPath, destPath);
        }
      } catch {
        // Skip files we can't read
      }
    }
  }
}

/** Walk a directory and return file paths with sizes. */
async function walkFiles(dir: string): Promise<Array<{ path: string; sizeBytes: number }>> {
  const results: Array<{ path: string; sizeBytes: number }> = [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await walkFiles(fullPath);
      results.push(...children);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        results.push({ path: fullPath, sizeBytes: stat.size });
      } catch {
        // Skip
      }
    }
  }

  return results;
}
