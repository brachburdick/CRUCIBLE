/**
 * Docker integration tests — validates the full pipeline:
 * runtime detection → image selection → container lifecycle → checks.
 *
 * Skips gracefully when Docker daemon is not available.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveImageTag } from '../sandbox/runtime-detect.js';
import { DockerRunner } from '../sandbox/docker-runner.js';
import type { TaskPayload } from '../types/index.js';
import type { DockerRunnerConfig } from '../sandbox/docker-runner.js';

// ─── Task fixtures ───

const PYTHON_FIBONACCI_TASK: TaskPayload = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tasks', 'python-fibonacci.json'), 'utf-8'),
);

const PYTHON_AUTODETECT_TASK: TaskPayload = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tasks', 'python-autodetect.json'), 'utf-8'),
);

const RUST_TASK: TaskPayload = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tasks', 'rust-hello.json'), 'utf-8'),
);

const GO_TASK: TaskPayload = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tasks', 'go-hello.json'), 'utf-8'),
);

const RUBY_TASK: TaskPayload = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tasks', 'ruby-hello.json'), 'utf-8'),
);

const JVM_TASK: TaskPayload = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tasks', 'jvm-hello.json'), 'utf-8'),
);

// ─── Docker availability check ───

function isDockerAvailable(): boolean {
  try {
    execSync('docker version --format "{{.Server.Version}}"', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function dockerImageExists(tag: string): boolean {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_OK = isDockerAvailable();
const PYTHON_IMAGE_OK = DOCKER_OK && dockerImageExists('crucible-runner:python');
const RUST_IMAGE_OK = DOCKER_OK && dockerImageExists('crucible-runner:rust');
const GO_IMAGE_OK = DOCKER_OK && dockerImageExists('crucible-runner:go');
const RUBY_IMAGE_OK = DOCKER_OK && dockerImageExists('crucible-runner:ruby');
const JVM_IMAGE_OK = DOCKER_OK && dockerImageExists('crucible-runner:jvm');

// ─── resolveImageTag tests (pure logic, no Docker needed) ───

describe('resolveImageTag — Python task payloads', () => {
  it('tier 2: explicit runtime "python" resolves to crucible-runner:python', () => {
    assert.equal(resolveImageTag(PYTHON_FIBONACCI_TASK), 'crucible-runner:python');
  });

  it('tier 3: auto-detects python from requirements.txt in inline files', () => {
    assert.equal(resolveImageTag(PYTHON_AUTODETECT_TASK), 'crucible-runner:python');
  });

  it('tier 3: auto-detect task has no runtime field', () => {
    assert.equal(PYTHON_AUTODETECT_TASK.runtime, undefined);
  });

  it('tier 2 wins over tier 3 when both present', () => {
    const task: TaskPayload = {
      description: 'test',
      instructions: 'test',
      runtime: 'python',
      files: { 'Cargo.toml': '[package]' },
    };
    assert.equal(resolveImageTag(task), 'crucible-runner:python');
  });
});

// ─── Docker container lifecycle tests ───

describe('DockerRunner — container lifecycle (Python image)', { skip: !PYTHON_IMAGE_OK && 'Docker or crucible-runner:python not available' }, () => {
  let runner: DockerRunner | null = null;
  const runId = `test-docker-int-${Date.now()}`;

  const config: DockerRunnerConfig = {
    runId,
    taskPayload: PYTHON_FIBONACCI_TASK,
    ttlSeconds: 60,
    systemPrompt: 'You are a test agent.',
  };

  after(async () => {
    if (runner) {
      await runner.destroy();
      runner = null;
    }
  });

  it('creates a container with the Python image', async () => {
    runner = await DockerRunner.create(config);
    assert.ok(runner, 'DockerRunner.create() returned a runner');
  });

  it('container has python3 available', () => {
    assert.ok(runner, 'runner must exist');
    // Access private containerId via bracket notation for testing
    const containerId = (runner as any).containerId as string;
    assert.ok(containerId.length > 0, 'container ID is non-empty');

    const version = execSync(`docker exec ${containerId} python3 --version`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    assert.match(version, /Python 3\.\d+/, `Expected Python 3.x, got: ${version}`);
  });

  it('container has pip available', () => {
    assert.ok(runner, 'runner must exist');
    const containerId = (runner as any).containerId as string;

    const version = execSync(`docker exec ${containerId} pip --version`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    assert.match(version, /pip \d+/, `Expected pip, got: ${version}`);
  });

  it('seeded files are present in /workspace/', () => {
    assert.ok(runner, 'runner must exist');
    const containerId = (runner as any).containerId as string;

    const files = execSync(`docker exec ${containerId} ls /workspace/`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    assert.ok(files.includes('README.md'), `Expected README.md in workspace, got: ${files}`);
  });

  it('can execute python inline and get correct output', () => {
    assert.ok(runner, 'runner must exist');
    const containerId = (runner as any).containerId as string;

    // Write a fibonacci script directly and run it
    execSync(
      `docker exec ${containerId} sh -c 'cat > /workspace/fibonacci.py << "PYEOF"
def fib(n):
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b

print(fib(10))
PYEOF'`,
      { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const output = execSync(`docker exec ${containerId} python3 /workspace/fibonacci.py`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    assert.equal(output, '55', `Expected fib(10)=55, got: ${output}`);
  });

  it('runChecks passes when correct code is in place', async () => {
    assert.ok(runner, 'runner must exist');

    const score = await runner.runChecks(PYTHON_FIBONACCI_TASK.checks!);
    // First check (file exists) and second (output=55) should pass
    // Third check (import fib) should also pass since we wrote the function
    assert.ok(score.passRate > 0, `Expected some checks to pass, got passRate=${score.passRate}`);
    assert.ok(score.checks.length === 3, `Expected 3 checks, got ${score.checks.length}`);

    for (const check of score.checks) {
      assert.ok(check.passed, `Check "${check.name}" failed: ${check.stderr ?? check.stdout}`);
    }
    assert.equal(score.passRate, 1, 'All checks should pass');
  });

  it('destroy is idempotent', async () => {
    assert.ok(runner, 'runner must exist');
    await runner.destroy();
    await runner.destroy(); // second call should not throw
    runner = null;
  });
});

// ─── Auto-detect task container lifecycle ───

describe('DockerRunner — auto-detect task (Tier 3)', { skip: !PYTHON_IMAGE_OK && 'Docker or crucible-runner:python not available' }, () => {
  let runner: DockerRunner | null = null;
  const runId = `test-docker-auto-${Date.now()}`;

  const config: DockerRunnerConfig = {
    runId,
    taskPayload: PYTHON_AUTODETECT_TASK,
    ttlSeconds: 60,
    systemPrompt: 'You are a test agent.',
  };

  after(async () => {
    if (runner) {
      await runner.destroy();
      runner = null;
    }
  });

  it('creates container — resolveImageTag picks python from requirements.txt', async () => {
    runner = await DockerRunner.create(config);
    assert.ok(runner, 'DockerRunner.create() returned a runner');
  });

  it('requirements.txt was seeded into /workspace/', () => {
    assert.ok(runner, 'runner must exist');
    const containerId = (runner as any).containerId as string;

    const content = execSync(`docker exec ${containerId} cat /workspace/requirements.txt`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    assert.ok(content.includes('requests'), `Expected requirements.txt to contain requests, got: ${content}`);
  });

  it('pip is functional and can list packages', () => {
    assert.ok(runner, 'runner must exist');
    const containerId = (runner as any).containerId as string;

    // Network is locked down in the container, so we can't pip install from PyPI.
    // Instead, verify pip works and the Python ecosystem image has pip + venv available.
    const output = execSync(`docker exec ${containerId} pip list --format=columns`, {
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();
    assert.ok(output.includes('pip'), `Expected pip in package list, got: ${output}`);
  });

  it('cleanup: destroy', async () => {
    assert.ok(runner, 'runner must exist');
    await runner.destroy();
    runner = null;
  });
});

// ─── resolveImageTag for all ecosystem tasks ───

describe('resolveImageTag — all ecosystem tasks', () => {
  it('rust task resolves to crucible-runner:rust', () => {
    assert.equal(resolveImageTag(RUST_TASK), 'crucible-runner:rust');
  });

  it('go task resolves to crucible-runner:go', () => {
    assert.equal(resolveImageTag(GO_TASK), 'crucible-runner:go');
  });

  it('ruby task resolves to crucible-runner:ruby', () => {
    assert.equal(resolveImageTag(RUBY_TASK), 'crucible-runner:ruby');
  });

  it('jvm task resolves to crucible-runner:jvm', () => {
    assert.equal(resolveImageTag(JVM_TASK), 'crucible-runner:jvm');
  });
});

// ─── Helper: ecosystem container lifecycle test ───

function ecosystemLifecycleTest(
  name: string,
  imageOk: boolean,
  task: TaskPayload,
  toolchainChecks: Array<{ name: string; command: string; pattern: RegExp }>,
) {
  describe(`DockerRunner — ${name} image lifecycle`, { skip: !imageOk && `Docker or crucible-runner:${name} not available` }, () => {
    let runner: DockerRunner | null = null;
    const runId = `test-docker-${name}-${Date.now()}`;

    const config: DockerRunnerConfig = {
      runId,
      taskPayload: task,
      ttlSeconds: 60,
      systemPrompt: 'You are a test agent.',
    };

    after(async () => {
      if (runner) {
        await runner.destroy();
        runner = null;
      }
    });

    it('creates a container', async () => {
      runner = await DockerRunner.create(config);
      assert.ok(runner, 'DockerRunner.create() returned a runner');
    });

    for (const check of toolchainChecks) {
      it(check.name, () => {
        assert.ok(runner, 'runner must exist');
        const containerId = (runner as any).containerId as string;
        // Run as agent user so user-installed tools (rustup, etc.) are on PATH
        const output = execSync(`docker exec -u agent ${containerId} sh -c '${check.command}'`, {
          encoding: 'utf-8',
          timeout: 30000,
        }).trim();
        assert.match(output, check.pattern, `${check.name}: got "${output}"`);
      });
    }

    it('base tools (node, python3, git) are available', () => {
      assert.ok(runner, 'runner must exist');
      const containerId = (runner as any).containerId as string;
      const output = execSync(
        `docker exec -u agent ${containerId} sh -c 'node --version && python3 --version && git --version'`,
        { encoding: 'utf-8', timeout: 10000 },
      ).trim();
      assert.match(output, /v20/, 'Expected Node 20');
      assert.match(output, /Python 3/, 'Expected Python 3');
      assert.match(output, /git version/, 'Expected git');
    });

    it('destroy', async () => {
      assert.ok(runner, 'runner must exist');
      await runner.destroy();
      runner = null;
    });
  });
}

// ─── Rust lifecycle ───

ecosystemLifecycleTest('rust', RUST_IMAGE_OK, RUST_TASK, [
  { name: 'has rustc', command: 'rustc --version', pattern: /rustc \d+/ },
  { name: 'has cargo', command: 'cargo --version', pattern: /cargo \d+/ },
]);

// ─── Go lifecycle ───

ecosystemLifecycleTest('go', GO_IMAGE_OK, GO_TASK, [
  { name: 'has go', command: 'go version', pattern: /go1\.\d+/ },
]);

// ─── Ruby lifecycle ───

ecosystemLifecycleTest('ruby', RUBY_IMAGE_OK, RUBY_TASK, [
  { name: 'has ruby', command: 'ruby --version', pattern: /ruby \d+/ },
  { name: 'has bundler', command: 'bundler --version', pattern: /Bundler version \d+/ },
]);

// ─── JVM lifecycle ───

ecosystemLifecycleTest('jvm', JVM_IMAGE_OK, JVM_TASK, [
  { name: 'has java', command: 'java --version 2>&1 | head -1', pattern: /openjdk \d+/ },
  { name: 'has mvn', command: 'mvn --version 2>&1 | head -1', pattern: /Maven/ },
  { name: 'has gradle', command: 'gradle --version 2>&1 | grep Gradle', pattern: /Gradle \d+/ },
]);
