/** Parse a number from an environment variable with a fallback default. */
export function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

/** Translate a KillReason type string to a CLI exit code. */
export function exitCodeFromReason(type: string): number {
  switch (type) {
    case 'completed': return 0;
    case 'budget_exceeded': return 1;
    case 'loop_detected': return 2;
    case 'ttl_exceeded': return 3;
    default: return 1;
  }
}
