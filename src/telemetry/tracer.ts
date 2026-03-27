import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { Tracer, Span } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type {
  RunConfig,
  KillReason,
  Middleware,
  LlmCallFn,
  LlmMessage,
  LlmCallOptions,
  LlmResponse,
} from '../types/index.js';
import { GENAI, CRUCIBLE } from './otel-attributes.js';

/** Middleware event passed to traceMiddlewareEvent */
export interface MiddlewareEvent {
  type: string;
  details?: Record<string, unknown>;
}

/**
 * Options for creating a RunTracer. Allows injecting a custom provider
 * for testing (in-memory exporter) without network calls.
 */
export interface RunTracerOptions {
  /** Custom TracerProvider — if omitted, creates one with OTLP exporter. */
  provider?: NodeTracerProvider;
}

/**
 * RunTracer manages a single OTel root span per run.
 * Agent code never receives a reference to this class — append-only by construction.
 *
 * Replaces the previous Langfuse-based implementation. Public API is identical.
 * Traces are exported via OTLP to any compatible backend (Langfuse v3, Jaeger,
 * Datadog, Grafana Tempo) configured via OTEL_EXPORTER_OTLP_ENDPOINT.
 */
export class RunTracer {
  private readonly provider: NodeTracerProvider;
  private readonly tracer: Tracer;
  private readonly rootSpan: Span;
  private readonly runId: string;
  private readonly startTime: Date;
  private readonly ownsProvider: boolean;

  private constructor(
    provider: NodeTracerProvider,
    tracer: Tracer,
    rootSpan: Span,
    runId: string,
    startTime: Date,
    ownsProvider: boolean,
  ) {
    this.provider = provider;
    this.tracer = tracer;
    this.rootSpan = rootSpan;
    this.runId = runId;
    this.startTime = startTime;
    this.ownsProvider = ownsProvider;
  }

  /**
   * Create a RunTracer with a root OTel span for the given run.
   *
   * Env vars:
   *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP endpoint (default: http://localhost:4318)
   *   OTEL_EXPORTER_OTLP_HEADERS  — Additional headers (e.g., auth for Langfuse)
   *   OTEL_SERVICE_NAME            — Service name (default: crucible)
   */
  static create(runConfig: RunConfig, options?: RunTracerOptions): RunTracer {
    const startTime = new Date();
    const runId = crypto.randomUUID();

    let provider: NodeTracerProvider;
    let ownsProvider: boolean;

    if (options?.provider) {
      provider = options.provider;
      ownsProvider = false;
    } else {
      const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';

      // Parse headers from env (format: "key=value,key2=value2")
      const headersEnv = process.env['OTEL_EXPORTER_OTLP_HEADERS'] ?? '';
      const headers: Record<string, string> = {};
      if (headersEnv) {
        for (const pair of headersEnv.split(',')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
          }
        }
      }

      const exporter = new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
        headers,
      });

      provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      ownsProvider = true;
    }

    const serviceName = process.env['OTEL_SERVICE_NAME'] ?? 'crucible';
    const tracer = provider.getTracer(serviceName, '0.1.0');

    const rootSpan = tracer.startSpan('crucible-run', {
      attributes: {
        [GENAI.OPERATION_NAME]: 'invoke_agent',
        [GENAI.AGENT_NAME]: runConfig.variantLabel,
        [CRUCIBLE.RUN_ID]: runId,
        [CRUCIBLE.VARIANT_LABEL]: runConfig.variantLabel,
        [CRUCIBLE.TOKEN_BUDGET]: runConfig.tokenBudget,
        [CRUCIBLE.TTL_SECONDS]: runConfig.ttlSeconds,
        [CRUCIBLE.TASK_DESCRIPTION]: runConfig.taskPayload.description,
      },
    });

    return new RunTracer(provider, tracer, rootSpan, runId, startTime, ownsProvider);
  }

  /** The run ID associated with this trace (generated at create time). */
  getRunId(): string {
    return this.runId;
  }

  /**
   * Returns a Middleware that wraps LlmCallFn with a child span
   * recording tokens in/out, model, and latency.
   */
  createTracerMiddleware(): Middleware {
    return (next: LlmCallFn): LlmCallFn => {
      return async (
        messages: LlmMessage[],
        options?: LlmCallOptions,
      ): Promise<LlmResponse> => {
        const parentCtx = trace.setSpan(context.active(), this.rootSpan);

        return context.with(parentCtx, async () => {
          const span = this.tracer.startSpan('llm-call', {
            attributes: {
              [GENAI.OPERATION_NAME]: 'chat',
              [GENAI.REQUEST_MODEL]: options?.model ?? 'unknown',
            },
          }, parentCtx);

          try {
            const response = await next(messages, options);

            span.setAttributes({
              [GENAI.USAGE_INPUT_TOKENS]: response.usage.promptTokens,
              [GENAI.USAGE_OUTPUT_TOKENS]: response.usage.completionTokens,
              [GENAI.REQUEST_MODEL]: response.model,
            });
            span.setStatus({ code: SpanStatusCode.OK });

            return response;
          } catch (err) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            span.end();
          }
        });
      };
    };
  }

  /**
   * Record a tool call as a child span on the root trace.
   */
  async traceToolCall(
    name: string,
    input: unknown,
    output: unknown,
    durationMs: number,
  ): Promise<void> {
    const parentCtx = trace.setSpan(context.active(), this.rootSpan);
    const span = this.tracer.startSpan(`tool-call:${name}`, {
      attributes: {
        [GENAI.OPERATION_NAME]: 'execute_tool',
        [GENAI.TOOL_NAME]: name,
      },
      startTime: new Date(Date.now() - durationMs),
    }, parentCtx);

    span.setAttribute('crucible.tool.input', JSON.stringify(input));
    span.setAttribute('crucible.tool.output', JSON.stringify(output));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  /**
   * Record a middleware event (budget warnings, loop flags) as a child span.
   */
  async traceMiddlewareEvent(event: MiddlewareEvent): Promise<void> {
    const parentCtx = trace.setSpan(context.active(), this.rootSpan);
    const span = this.tracer.startSpan(`middleware-event:${event.type}`, {
      attributes: {
        'crucible.event.type': event.type,
      },
    }, parentCtx);

    if (event.details) {
      for (const [key, value] of Object.entries(event.details)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          span.setAttribute(`crucible.event.${key}`, value);
        }
      }
    }

    span.end();
  }

  /**
   * Close the root span with the kill reason and final token count,
   * then shut down the provider to flush all pending spans.
   * If shutdown fails, the error is logged but not thrown — teardown must not be blocked.
   */
  async close(killReason: KillReason, tokenCount: number): Promise<void> {
    const wallTimeMs = Date.now() - this.startTime.getTime();

    this.rootSpan.setAttributes({
      [CRUCIBLE.KILL_REASON_TYPE]: killReason.type,
      'crucible.token.count': tokenCount,
      'crucible.wall_time_ms': wallTimeMs,
    });

    if (killReason.type === 'completed') {
      this.rootSpan.setStatus({ code: SpanStatusCode.OK });
    } else {
      this.rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: killReason.type,
      });
    }

    this.rootSpan.end();

    if (this.ownsProvider) {
      try {
        await this.provider.shutdown();
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'otel_shutdown_failed',
            runId: this.runId,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }
}
