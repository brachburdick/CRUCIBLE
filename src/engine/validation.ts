import type { TaskPayload } from '../types/index.js';

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

  if (obj['networkAllowlist'] !== undefined) {
    if (!Array.isArray(obj['networkAllowlist'])) {
      throw new Error('Task payload "networkAllowlist" must be an array');
    }
    payload.networkAllowlist = obj['networkAllowlist'] as string[];
  }

  return payload;
}
