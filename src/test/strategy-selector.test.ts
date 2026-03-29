/**
 * StrategySelector tests — covers every path through the cascade decision tree,
 * including boundary conditions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectStrategy } from '../engine/StrategySelector.js';
import type { DeepCheck, CascadeInput } from '../engine/StrategySelector.js';

// ─── Helpers ───

function makeChecks(overrides: Partial<Record<DeepCheck['heuristic'], { value: string | number; level: DeepCheck['level'] }>>): DeepCheck[] {
  const defaults: Record<DeepCheck['heuristic'], { value: string | number; level: DeepCheck['level']; detail: string }> = {
    estimated_duration: { value: 15, level: 'green', detail: '~15 min' },
    file_count: { value: 2, level: 'green', detail: '2 files' },
    change_entropy: { value: 1, level: 'green', detail: '1 module' },
    architectural_scope: { value: 'localized', level: 'green', detail: 'Localized change' },
  };

  return (Object.keys(defaults) as DeepCheck['heuristic'][]).map(heuristic => ({
    heuristic,
    value: overrides[heuristic]?.value ?? defaults[heuristic].value,
    level: overrides[heuristic]?.level ?? defaults[heuristic].level,
    detail: defaults[heuristic].detail,
  }));
}

function input(taskIntent: CascadeInput['taskIntent'], checks: DeepCheck[]): CascadeInput {
  return { checks, taskIntent };
}

// ─── Tests ───

describe('StrategySelector', () => {

  // Path 1: Diagnostic → D0
  describe('diagnostic intent', () => {
    it('always suggests D0 for diagnostic tasks', () => {
      const result = selectStrategy(input('diagnostic', makeChecks({
        estimated_duration: { value: 600, level: 'red' },
        file_count: { value: 50, level: 'red' },
      })));
      assert.equal(result.suggested, 'D0');
      assert.match(result.reason, /diagnostic/i);
      assert.equal(result.flags.humanReviewRecommended, false);
    });
  });

  // Path 2: Duration <30 AND files ≤3 → D0
  describe('small task (duration <30 AND ≤3 files)', () => {
    it('suggests D0 for small tasks', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 15, level: 'green' },
        file_count: { value: 2, level: 'green' },
      })));
      assert.equal(result.suggested, 'D0');
      assert.match(result.reason, /single-agent/i);
    });

    it('boundary: exactly 29 min and 3 files → D0', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 29, level: 'green' },
        file_count: { value: 3, level: 'green' },
      })));
      assert.equal(result.suggested, 'D0');
    });

    it('boundary: exactly 30 min breaks the small-task path', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 30, level: 'amber' },
        file_count: { value: 2, level: 'green' },
      })));
      // 30 min is NOT <30, so doesn't match path 2. Falls through.
      // With 2 files, ≤10, entropy 1 module, scope localized → default D0
      assert.equal(result.suggested, 'D0');
      assert.match(result.reason, /no decomposition/i);
    });

    it('boundary: exactly 4 files breaks the small-task path', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 15, level: 'green' },
        file_count: { value: 4, level: 'amber' },
      })));
      // 15 min <30 but 4 files > 3, so doesn't match path 2
      // Falls through: 4 files ≤10, entropy 1 → default D0
      assert.equal(result.suggested, 'D0');
    });
  });

  // Path 3: Duration >4 hr → D4 + humanReviewRecommended
  describe('long duration (>4 hr)', () => {
    it('suggests D4 with human review for >240 min', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 300, level: 'red' },
        file_count: { value: 5, level: 'amber' },
      })));
      assert.equal(result.suggested, 'D4');
      assert.match(result.reason, /4-hour/i);
      assert.equal(result.flags.humanReviewRecommended, true);
    });

    it('boundary: exactly 240 min does NOT trigger (must be >240)', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 240, level: 'amber' },
        file_count: { value: 5, level: 'amber' },
      })));
      // 240 is not >240, falls through. 5 files ≤10, 1 module → default D0
      assert.equal(result.suggested, 'D0');
    });

    it('boundary: 241 min triggers', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 241, level: 'red' },
        file_count: { value: 2, level: 'green' },
      })));
      assert.equal(result.suggested, 'D4');
      assert.equal(result.flags.humanReviewRecommended, true);
    });
  });

  // Path 4: File count >10 OR entropy >2 → D4
  describe('high file count or entropy', () => {
    it('suggests D4 for >10 files', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 15, level: 'red' },
      })));
      assert.equal(result.suggested, 'D4');
      assert.match(result.reason, /scale or spread/i);
    });

    it('boundary: exactly 10 files does NOT trigger', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 10, level: 'amber' },
      })));
      // 10 is not >10, falls to default
      assert.equal(result.suggested, 'D0');
    });

    it('boundary: 11 files triggers', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 11, level: 'red' },
      })));
      assert.equal(result.suggested, 'D4');
    });

    it('suggests D4 for entropy >2 modules', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 5, level: 'amber' },
        change_entropy: { value: 3, level: 'red' },
      })));
      assert.equal(result.suggested, 'D4');
      assert.match(result.reason, /scale or spread/i);
    });

    it('boundary: exactly 2 modules does NOT trigger', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 5, level: 'amber' },
        change_entropy: { value: 2, level: 'amber' },
      })));
      // 2 is not >2, falls through
      assert.equal(result.suggested, 'D0');
    });
  });

  // Path 5: Architectural scope → D4 + planningFirstSubtask
  describe('architectural scope', () => {
    it('suggests D4 with planningFirstSubtask for architectural scope', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 5, level: 'amber' },
        architectural_scope: { value: 'architectural', level: 'amber' },
      })));
      assert.equal(result.suggested, 'D4');
      assert.match(result.reason, /architectural/i);
      assert.equal(result.flags.planningFirstSubtask, true);
    });

    it('does not trigger for localized scope with green level', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 5, level: 'amber' },
        architectural_scope: { value: 'localized', level: 'green' },
      })));
      assert.equal(result.suggested, 'D0');
    });
  });

  // Path 6: Default → D0
  describe('default fallthrough', () => {
    it('suggests D0 when nothing triggers', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 60, level: 'amber' },
        file_count: { value: 5, level: 'amber' },
        change_entropy: { value: 2, level: 'amber' },
        architectural_scope: { value: 'localized', level: 'green' },
      })));
      assert.equal(result.suggested, 'D0');
      assert.match(result.reason, /no decomposition/i);
      assert.equal(result.flags.humanReviewRecommended, false);
      assert.equal(result.flags.planningFirstSubtask, false);
    });
  });

  // Edge: empty checks
  describe('edge cases', () => {
    it('handles empty checks array gracefully', () => {
      const result = selectStrategy({ checks: [], taskIntent: 'implementation' });
      // All numeric values default to 0: duration=0 <30, files=0 ≤3 → D0
      assert.equal(result.suggested, 'D0');
      assert.match(result.reason, /single-agent/i);
    });

    it('never suggests D5', () => {
      // Even with extreme values, D5 is never suggested
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 10000, level: 'red' },
        file_count: { value: 100, level: 'red' },
        change_entropy: { value: 20, level: 'red' },
        architectural_scope: { value: 'architectural', level: 'red' },
      })));
      assert.notEqual(result.suggested, 'D5' as 'D0' | 'D4');
      assert.equal(result.suggested, 'D4');
    });
  });

  // Priority: diagnostic overrides everything
  describe('priority ordering', () => {
    it('diagnostic overrides all other signals', () => {
      const result = selectStrategy(input('diagnostic', makeChecks({
        estimated_duration: { value: 500, level: 'red' },
        file_count: { value: 50, level: 'red' },
        change_entropy: { value: 10, level: 'red' },
        architectural_scope: { value: 'architectural', level: 'red' },
      })));
      assert.equal(result.suggested, 'D0');
    });

    it('long duration takes priority over file count/entropy', () => {
      const result = selectStrategy(input('implementation', makeChecks({
        estimated_duration: { value: 300, level: 'red' },
        file_count: { value: 20, level: 'red' },
        change_entropy: { value: 5, level: 'red' },
      })));
      assert.equal(result.suggested, 'D4');
      assert.equal(result.flags.humanReviewRecommended, true);
      // humanReviewRecommended is set by the duration path, not file/entropy
    });
  });
});
