/**
 * OpenTelemetry GenAI semantic convention attribute names.
 *
 * Pinned to ~v1.40.0. These conventions are EXPERIMENTAL and break every
 * 2-3 months. All gen_ai.* attribute names live here so updates are a
 * single-file change.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GENAI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  AGENT_NAME: 'gen_ai.agent.name',
  TOOL_NAME: 'gen_ai.tool.name',
  EVALUATION_SCORE_LABEL: 'gen_ai.evaluation.score.label',
} as const;

/** CRUCIBLE-specific attribute names (not part of OTel conventions). */
export const CRUCIBLE = {
  RUN_ID: 'crucible.run.id',
  VARIANT_LABEL: 'crucible.variant.label',
  TOKEN_BUDGET: 'crucible.token.budget',
  TTL_SECONDS: 'crucible.ttl.seconds',
  KILL_REASON_TYPE: 'crucible.kill_reason.type',
  TASK_DESCRIPTION: 'crucible.task.description',
} as const;
