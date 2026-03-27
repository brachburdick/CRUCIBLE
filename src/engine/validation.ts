import type { TaskPayload, CheckSpec } from '../types/index.js';

/**
 * Validate and parse a raw JSON object into a TaskPayload.
 * Throws descriptive errors for missing/invalid fields.
 */
export function validateTaskPayload(raw: unknown): TaskPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Task payload must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['description'] !== 'string' || obj['description'].length === 0) {
    throw new Error('Task payload must have a non-empty "description" string');
  }
  if (typeof obj['instructions'] !== 'string' || obj['instructions'].length === 0) {
    throw new Error('Task payload must have a non-empty "instructions" string');
  }

  const payload: TaskPayload = {
    description: obj['description'],
    instructions: obj['instructions'],
  };

  if (obj['files'] !== undefined) {
    if (typeof obj['files'] !== 'object' || obj['files'] === null) {
      throw new Error('Task payload "files" must be an object');
    }
    payload.files = obj['files'] as Record<string, string>;
  }

  if (obj['seedDir'] !== undefined) {
    if (typeof obj['seedDir'] !== 'string') {
      throw new Error('Task payload "seedDir" must be a string path');
    }
    payload.seedDir = obj['seedDir'];
  }

  if (obj['networkAllowlist'] !== undefined) {
    if (!Array.isArray(obj['networkAllowlist'])) {
      throw new Error('Task payload "networkAllowlist" must be an array');
    }
    payload.networkAllowlist = obj['networkAllowlist'] as string[];
  }

  if (obj['checks'] !== undefined) {
    if (!Array.isArray(obj['checks'])) {
      throw new Error('Task payload "checks" must be an array');
    }
    payload.checks = (obj['checks'] as Record<string, unknown>[]).map(validateCheckSpec);
  }

  return payload;
}

function validateCheckSpec(raw: Record<string, unknown>): CheckSpec {
  if (typeof raw['name'] !== 'string' || !raw['name']) {
    throw new Error('Check spec must have a non-empty "name" string');
  }
  if (raw['type'] !== 'exec') {
    throw new Error(`Check spec type must be "exec", got "${String(raw['type'])}"`);
  }
  if (typeof raw['command'] !== 'string' || !raw['command']) {
    throw new Error('Check spec must have a non-empty "command" string');
  }
  return {
    name: raw['name'],
    type: 'exec',
    command: raw['command'],
    expectedExitCode: typeof raw['expectedExitCode'] === 'number' ? raw['expectedExitCode'] : undefined,
    timeout: typeof raw['timeout'] === 'number' ? raw['timeout'] : undefined,
  };
}
