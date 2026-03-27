// Telemetry layer — OTel traces + Prometheus metrics (Phase 5)
export { RunTracer } from './tracer.js';
export type { MiddlewareEvent, RunTracerOptions } from './tracer.js';
export { GENAI, CRUCIBLE as CRUCIBLE_ATTRS } from './otel-attributes.js';
export { CrucibleMetrics } from './metrics.js';
