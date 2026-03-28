import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskPayload, RuntimeEcosystem } from '../types/index.js';

const DEFAULT_IMAGE_TAG = 'crucible-runner:base';

/**
 * Signature files mapped to runtime ecosystems.
 * Order matters — first match wins.
 * package.json is last because the base image already includes Node 20.
 */
const SIGNATURE_FILES: ReadonlyArray<[string, RuntimeEcosystem]> = [
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['Gemfile', 'ruby'],
  ['pom.xml', 'jvm'],
  ['build.gradle', 'jvm'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['setup.py', 'python'],
  ['package.json', 'node'],
];

/**
 * Detect the runtime ecosystem from a directory by scanning for signature files.
 * Returns null if no known ecosystem is detected.
 */
export function detectRuntime(dir: string): RuntimeEcosystem | null {
  for (const [file, runtime] of SIGNATURE_FILES) {
    if (fs.existsSync(path.join(dir, file))) {
      return runtime;
    }
  }
  return null;
}

/**
 * Resolve the Docker image tag for a task using the 3-tier cascade:
 *   1. Explicit image override (task.image)
 *   2. Explicit runtime field (task.runtime → crucible-runner:<runtime>)
 *   3. Auto-detect from seedDir signature files
 *   4. Fallback to crucible-runner:base
 */
export function resolveImageTag(task: TaskPayload): string {
  // Tier 1: full image override
  if (task.image) {
    return task.image;
  }

  // Tier 2: explicit runtime
  if (task.runtime) {
    return `crucible-runner:${task.runtime}`;
  }

  // Tier 3: auto-detect from seedDir
  if (task.seedDir) {
    const detected = detectRuntime(task.seedDir);
    if (detected) {
      return `crucible-runner:${detected}`;
    }
  }

  // Also check inline files for signature filenames
  if (task.files) {
    for (const [file, runtime] of SIGNATURE_FILES) {
      if (task.files[file] !== undefined) {
        return `crucible-runner:${runtime}`;
      }
    }
  }

  // Tier 4: fallback
  return DEFAULT_IMAGE_TAG;
}
