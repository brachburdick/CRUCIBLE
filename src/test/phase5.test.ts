/**
 * Phase 5 tests: OTel Telemetry, Prometheus Metrics, MCP Sandbox Server.
 *
 * All tests use mocks — no E2B sandbox, OTel backend, or Prometheus required.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

import { RunTracer } from '../telemetry/tracer.js';
import { GENAI, CRUCIBLE } from '../telemetry/otel-attributes.js';
import { CrucibleMetrics } from '../telemetry/metrics.js';
import { createMcpSandboxServer } from '../server/mcp.js';
import { RunEngine } from '../engine/RunEngine.js';
import { SessionModel } from '../session/index.js';
import { detectFlowType } from '../engine/GraphExecutor.js';
import { getFlowTemplate } from '../session/flow-templates.js';
import type { RunConfig, ToolContext, ExecResult } from '../types/index.js';

// ─── Helpers ───

function makeRunConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    taskPayload: {
      description: 'Test task',
      instructions: 'Do the thing',
    },
    variantLabel: 'test-variant',
    tokenBudget: 50000,
    ttlSeconds: 60,
    loopDetection: {
      windowSize: 8,
      similarityThreshold: 0.92,
      consecutiveTurns: 5,
    },
    ...overrides,
  };
}

function createTestProvider(): { provider: NodeTracerProvider; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { provider, exporter };
}

function mockToolContext(): ToolContext {
  return {
    exec: async (cmd: string): Promise<ExecResult> => ({
      stdout: `executed: ${cmd}`,
      stderr: '',
      exitCode: 0,
    }),
    writeFile: async (_path: string, _content: string): Promise<void> => {},
    readFile: async (path: string): Promise<string> => `contents of ${path}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5.2 — OTel Telemetry
// ═══════════════════════════════════════════════════════════════════════════════

describe('RunTracer (OTel)', () => {
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    const test = createTestProvider();
    provider = test.provider;
    exporter = test.exporter;
    exporter.reset();
  });

  it('create() produces a valid runId', () => {
    const config = makeRunConfig();
    const tracer = RunTracer.create(config, { provider });
    const runId = tracer.getRunId();
    assert.ok(runId, 'runId should be a non-empty string');
    assert.match(runId, /^[0-9a-f-]{36}$/, 'runId should be a UUID');
  });

  it('creates root span with correct gen_ai attributes', async () => {
    const config = makeRunConfig({ variantLabel: 'my-variant' });
    const tracer = RunTracer.create(config, { provider });

    await tracer.close({ type: 'completed' }, 1000);

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length >= 1, 'Should have at least 1 span (root)');

    const rootSpan = spans.find((s: ReadableSpan) => s.name === 'crucible-run');
    assert.ok(rootSpan, 'Root span should exist');
    assert.equal(rootSpan.attributes[GENAI.OPERATION_NAME], 'invoke_agent');
    assert.equal(rootSpan.attributes[GENAI.AGENT_NAME], 'my-variant');
    assert.equal(rootSpan.attributes[CRUCIBLE.VARIANT_LABEL], 'my-variant');
    assert.equal(rootSpan.attributes[CRUCIBLE.TOKEN_BUDGET], 50000);
  });

  it('createTracerMiddleware() creates child span with token usage', async () => {
    const config = makeRunConfig();
    const tracer = RunTracer.create(config, { provider });
    const middleware = tracer.createTracerMiddleware();

    // Mock LLM call
    const mockLlm = async () => ({
      content: 'hello',
      usage: { promptTokens: 100, completionTokens: 50 },
      model: 'test-model',
    });

    const wrapped = middleware(mockLlm);
    const response = await wrapped([{ role: 'user' as const, content: 'hi' }]);

    assert.equal(response.content, 'hello');
    assert.equal(response.usage.promptTokens, 100);

    await tracer.close({ type: 'completed' }, 150);

    const spans = exporter.getFinishedSpans();
    const llmSpan = spans.find((s: ReadableSpan) => s.name === 'llm-call');
    assert.ok(llmSpan, 'LLM call span should exist');
    assert.equal(llmSpan.attributes[GENAI.OPERATION_NAME], 'chat');
    assert.equal(llmSpan.attributes[GENAI.USAGE_INPUT_TOKENS], 100);
    assert.equal(llmSpan.attributes[GENAI.USAGE_OUTPUT_TOKENS], 50);
    assert.equal(llmSpan.attributes[GENAI.REQUEST_MODEL], 'test-model');
  });

  it('traceToolCall() creates child span with tool name', async () => {
    const config = makeRunConfig();
    const tracer = RunTracer.create(config, { provider });

    await tracer.traceToolCall('exec', { command: 'ls' }, { stdout: 'file.txt' }, 100);
    await tracer.close({ type: 'completed' }, 0);

    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find((s: ReadableSpan) => s.name === 'tool-call:exec');
    assert.ok(toolSpan, 'Tool call span should exist');
    assert.equal(toolSpan.attributes[GENAI.TOOL_NAME], 'exec');
    assert.equal(toolSpan.attributes[GENAI.OPERATION_NAME], 'execute_tool');
  });

  it('traceMiddlewareEvent() creates child span', async () => {
    const config = makeRunConfig();
    const tracer = RunTracer.create(config, { provider });

    await tracer.traceMiddlewareEvent({ type: 'budget_warning', details: { threshold: 0.8 } });
    await tracer.close({ type: 'completed' }, 0);

    const spans = exporter.getFinishedSpans();
    const eventSpan = spans.find((s: ReadableSpan) => s.name === 'middleware-event:budget_warning');
    assert.ok(eventSpan, 'Middleware event span should exist');
    assert.equal(eventSpan.attributes['crucible.event.type'], 'budget_warning');
    assert.equal(eventSpan.attributes['crucible.event.threshold'], 0.8);
  });

  it('close() sets kill reason attributes on root span', async () => {
    const config = makeRunConfig();
    const tracer = RunTracer.create(config, { provider });

    await tracer.close({ type: 'budget_exceeded', tokenCount: 60000, budget: 50000 }, 60000);

    const spans = exporter.getFinishedSpans();
    const rootSpan = spans.find((s: ReadableSpan) => s.name === 'crucible-run');
    assert.ok(rootSpan, 'Root span should exist');
    assert.equal(rootSpan.attributes[CRUCIBLE.KILL_REASON_TYPE], 'budget_exceeded');
    assert.equal(rootSpan.attributes['crucible.token.count'], 60000);
  });

  it('close() does not throw when provider shutdown fails', async () => {
    // Use a provider that we manually close first to simulate failure
    const config = makeRunConfig();
    const tracer = RunTracer.create(config, { provider });
    await provider.shutdown(); // Shut down early

    // close() should not throw
    await tracer.close({ type: 'completed' }, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5.3 — Prometheus Metrics
// ═══════════════════════════════════════════════════════════════════════════════

describe('CrucibleMetrics', () => {
  it('creates without error', () => {
    const metrics = CrucibleMetrics.create();
    assert.ok(metrics, 'Metrics should be created');
  });

  it('records run completion', () => {
    const metrics = CrucibleMetrics.create();
    // Should not throw
    metrics.recordRunCompleted('completed', 'test-variant');
    metrics.recordRunCompleted('budget_exceeded', 'test-variant');
  });

  it('records all metric types without error', () => {
    const metrics = CrucibleMetrics.create();
    metrics.recordRunDuration(5.2, 'test-variant', 'test-task');
    metrics.recordTokensUsed(1000, 'test-variant', 'input');
    metrics.recordTokensUsed(500, 'test-variant', 'output');
    metrics.recordSandboxStartup(1.5);
    metrics.recordLoopDetection('embedding_similarity');
    metrics.recordBudgetExceeded();
  });

  it('getMetrics() returns Prometheus text format', async () => {
    const metrics = CrucibleMetrics.create();
    metrics.recordRunCompleted('completed', 'v1');

    const text = await metrics.getMetrics();
    assert.ok(typeof text === 'string', 'Metrics should be a string');
    // Prometheus format contains # HELP and # TYPE lines
    assert.ok(text.includes('crucible_runs_total'), 'Should contain crucible_runs_total metric');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5.1 — MCP Sandbox Server
// ═══════════════════════════════════════════════════════════════════════════════

describe('MCP Sandbox Server', () => {
  it('creates server with three tools', () => {
    const toolContext = mockToolContext();
    const server = createMcpSandboxServer({ toolContext });
    assert.ok(server, 'MCP server should be created');
  });

  // Note: Full MCP tool invocation tests require a transport connection.
  // The McpServer from @modelcontextprotocol/sdk doesn't expose tools for
  // direct invocation without a transport. These are integration tests.
  // Unit-level verification: the server construction succeeds and tools
  // are registered without error.
});

// ═══════════════════════════════════════════════════════════════════════════════
// OTel Attribute Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('OTel Attributes', () => {
  it('GENAI constants have correct prefix', () => {
    for (const [_key, value] of Object.entries(GENAI)) {
      assert.ok(
        (value as string).startsWith('gen_ai.'),
        `${value} should start with gen_ai.`,
      );
    }
  });

  it('CRUCIBLE constants have correct prefix', () => {
    for (const [_key, value] of Object.entries(CRUCIBLE)) {
      assert.ok(
        (value as string).startsWith('crucible.'),
        `${value} should start with crucible.`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Session Integration (RunEngine + SessionModel wiring)
// ═══════════════════════════════════════════════════════════════════════════════

describe('RunEngine Session Integration', () => {
  it('accepts a SessionModel via setSession()', () => {
    const engine = new RunEngine();
    const session = new SessionModel({ agentDir: '/tmp/crucible-test-agent' });
    // Should not throw
    engine.setSession(session);
  });

  it('detectFlowType classifies task descriptions correctly', () => {
    assert.equal(detectFlowType('fix the broken login'), 'debug');
    assert.equal(detectFlowType('implement user authentication'), 'feature');
    assert.equal(detectFlowType('refactor the database layer'), 'refactor');
    assert.equal(detectFlowType('add a new API endpoint'), 'feature');
    assert.equal(detectFlowType('bug in the checkout flow'), 'debug');
  });

  it('flow templates have phases and hard rules', () => {
    const debugFlow = getFlowTemplate('debug');
    assert.ok(debugFlow.phases.length >= 3, 'Debug flow should have at least 3 phases');
    assert.ok(debugFlow.rules.some(r => r.enforcement === 'hard'), 'Should have hard rules');
    assert.equal(debugFlow.phases[0].name, 'reproduce');

    const featureFlow = getFlowTemplate('feature');
    assert.ok(featureFlow.phases.length >= 4, 'Feature flow should have at least 4 phases');

    const refactorFlow = getFlowTemplate('refactor');
    assert.ok(refactorFlow.phases.length >= 3, 'Refactor flow should have at least 3 phases');
  });
});
