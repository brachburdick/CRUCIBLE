// Sandbox layer — E2B sandbox lifecycle (TASK-003)
export { SandboxRunner } from './runner.js';

// Teardown convergence — single path for all kill reasons (TASK-008)
export { teardown, createIdempotentTeardown } from './teardown.js';
export type { TeardownContext } from './teardown.js';
