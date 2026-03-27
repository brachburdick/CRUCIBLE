import type { CheckSpec, ScoreResult, ToolContext } from '../types/index.js';

/**
 * Run acceptance checks against the sandbox after the agent completes.
 *
 * Each check is executed as a shell command in the sandbox via the ToolContext.
 * A check passes if the command's exit code matches expectedExitCode (default: 0).
 *
 * This MUST be called before sandbox teardown so the sandbox is still available.
 */
export async function runChecks(
  checks: CheckSpec[],
  tools: ToolContext,
): Promise<ScoreResult> {
  const results: ScoreResult['checks'] = [];

  for (const check of checks) {
    try {
      const execResult = await tools.exec(check.command);
      const expectedCode = check.expectedExitCode ?? 0;
      const passed = execResult.exitCode === expectedCode;

      results.push({
        name: check.name,
        passed,
        stdout: execResult.stdout || undefined,
        stderr: execResult.stderr || undefined,
        exitCode: execResult.exitCode,
      });
    } catch (err) {
      results.push({
        name: check.name,
        passed: false,
        stderr: `Check execution error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const passRate = checks.length > 0 ? passedCount / checks.length : 1;

  return { checks: results, passRate };
}
