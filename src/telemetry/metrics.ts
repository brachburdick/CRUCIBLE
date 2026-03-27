import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import type { Counter, Histogram } from '@opentelemetry/api';

/**
 * CrucibleMetrics provides Prometheus-scrapable operational metrics.
 *
 * The PrometheusExporter is configured with preventServerStart=true so it
 * does NOT start its own HTTP server. Instead, the Fastify server registers
 * a /metrics route that delegates to the exporter's request handler.
 */
export class CrucibleMetrics {
  private readonly exporter: PrometheusExporter;

  readonly runsTotal: Counter;
  readonly runDurationSeconds: Histogram;
  readonly tokensUsedTotal: Counter;
  readonly sandboxStartupSeconds: Histogram;
  readonly loopDetectionsTotal: Counter;
  readonly budgetExceededTotal: Counter;

  private constructor(exporter: PrometheusExporter, provider: MeterProvider) {
    this.exporter = exporter;

    const meter = provider.getMeter('crucible', '0.1.0');

    this.runsTotal = meter.createCounter('crucible_runs_total', {
      description: 'Total number of completed runs',
    });

    this.runDurationSeconds = meter.createHistogram('crucible_run_duration_seconds', {
      description: 'Run duration in seconds',
    });

    this.tokensUsedTotal = meter.createCounter('crucible_tokens_used_total', {
      description: 'Total tokens consumed',
    });

    this.sandboxStartupSeconds = meter.createHistogram('crucible_sandbox_startup_seconds', {
      description: 'Sandbox startup time in seconds',
    });

    this.loopDetectionsTotal = meter.createCounter('crucible_loop_detections_total', {
      description: 'Total loop detections by tier',
    });

    this.budgetExceededTotal = meter.createCounter('crucible_budget_exceeded_total', {
      description: 'Total budget exceeded events',
    });
  }

  static create(): CrucibleMetrics {
    const exporter = new PrometheusExporter({ preventServerStart: true });
    const provider = new MeterProvider({
      readers: [exporter],
    });

    return new CrucibleMetrics(exporter, provider);
  }

  /**
   * Get Prometheus text format metrics for the /metrics endpoint.
   * Uses the exporter's built-in HTTP handler to generate the response.
   */
  async getMetrics(): Promise<string> {
    return new Promise<string>((resolve) => {
      const fakeRes = {
        statusCode: 200,
        end: (data: string) => resolve(data),
        setHeader: (_name: string, _value: string) => {},
      };
      this.exporter.getMetricsRequestHandler(
        {} as import('node:http').IncomingMessage,
        fakeRes as unknown as import('node:http').ServerResponse,
      );
    });
  }

  // ─── Convenience methods ───

  recordRunCompleted(status: string, variant: string): void {
    this.runsTotal.add(1, { status, variant });
  }

  recordRunDuration(durationSeconds: number, variant: string, task: string): void {
    this.runDurationSeconds.record(durationSeconds, { variant, task });
  }

  recordTokensUsed(tokens: number, variant: string, direction: 'input' | 'output'): void {
    this.tokensUsedTotal.add(tokens, { variant, direction });
  }

  recordSandboxStartup(durationSeconds: number): void {
    this.sandboxStartupSeconds.record(durationSeconds);
  }

  recordLoopDetection(tier: string): void {
    this.loopDetectionsTotal.add(1, { tier });
  }

  recordBudgetExceeded(): void {
    this.budgetExceededTotal.add(1);
  }
}
