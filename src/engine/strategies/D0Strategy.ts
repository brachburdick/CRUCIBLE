/**
 * D0Strategy — Direct execution (no decomposition).
 *
 * Wraps the entire task as a single leaf node. This is the fast path
 * for simple tasks that don't need decomposition.
 */

import type { TaskPayload } from '../../types/index.js';
import type { DecompositionGraph } from '../../types/graph.js';
import type { DecompositionStrategy, DecompositionContext } from '../DecompositionEngine.js';
import { GraphBuilder } from '../GraphBuilder.js';

export class D0Strategy implements DecompositionStrategy {
  name = 'D0';

  async decompose(
    task: TaskPayload,
    _context: DecompositionContext,
  ): Promise<DecompositionGraph> {
    const builder = new GraphBuilder(task, 'direct', this.name);

    builder.addNode({
      id: 'root',
      type: 'leaf',
      description: task.description,
      acceptanceCriteria: task.checks?.map(c => c.name) ?? [],
      ownedPaths: task.files ? Object.keys(task.files) : [],
      status: 'ready',
    });

    return builder.build();
  }
}
