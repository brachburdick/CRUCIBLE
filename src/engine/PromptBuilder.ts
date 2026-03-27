/**
 * System Prompt Builder — constructs the system prompt injected into each
 * node's sandboxed agent.
 *
 * Includes role, task, scope boundary, flow phases/rules, upstream inputs,
 * session knowledge, and constraint reminders.
 */

import type { DecompositionGraph, DecompositionNode } from '../types/graph.js';
import type { FlowTemplate } from '../session/types.js';
import type { SessionKnowledge } from '../session/types.js';

export interface PromptBuilderContext {
  node: DecompositionNode;
  flow: FlowTemplate;
  graph: DecompositionGraph;
  sessionKnowledge: SessionKnowledge;
}

/**
 * Build the system prompt for a node's agent execution.
 */
export function buildNodePrompt(
  node: DecompositionNode,
  flow: FlowTemplate,
  graph: DecompositionGraph,
  sessionKnowledge: SessionKnowledge,
): string {
  const sections: string[] = [];

  // ── Role ──
  sections.push(`# Role\nYou are an agent executing node "${node.id}" of a decomposition graph.`);

  // ── Task ──
  sections.push(`# Task\n${node.description}`);

  // ── Acceptance Criteria ──
  if (node.acceptanceCriteria.length > 0) {
    const criteria = node.acceptanceCriteria.map(c => `- ${c}`).join('\n');
    sections.push(`# Acceptance Criteria\n${criteria}`);
  }

  // ── Scope Boundary ──
  if (node.ownedPaths.length > 0) {
    const paths = node.ownedPaths.map(p => `- ${p}`).join('\n');
    sections.push(
      `# Scope Boundary\nYou may only modify files in the following paths:\n${paths}\n\nWARNING: Edits to files outside this scope will be blocked.`,
    );
  }

  // ── Flow Phases ──
  const phaseList = flow.phases
    .map((p, i) => `${i + 1}. **${p.name}**: ${p.description}`)
    .join('\n');
  sections.push(`# Flow: ${flow.type}\n${flow.description}\n\n## Phases\n${phaseList}`);

  // ── Flow Rules ──
  if (flow.rules.length > 0) {
    const rules = flow.rules
      .map(r => `- ${r.enforcement === 'hard' ? 'MUST' : 'SHOULD'}: ${r.description}`)
      .join('\n');
    sections.push(`## Rules\n${rules}`);
  }

  // ── Upstream Inputs ──
  const upstreamEdges = graph.edges.filter(e => e.to === node.id);
  if (upstreamEdges.length > 0) {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    const inputs = upstreamEdges
      .map(e => {
        const source = nodeMap.get(e.from);
        if (!source) return null;
        const artifacts = source.outputs
          .map(a => `  - ${a.artifactId} (${a.type})`)
          .join('\n');
        return `- From node "${source.id}" (${source.description})${artifacts ? ':\n' + artifacts : ''}`;
      })
      .filter(Boolean)
      .join('\n');
    if (inputs) {
      sections.push(`# Upstream Inputs\n${inputs}`);
    }
  }

  // ── Session Knowledge ──
  const knowledge: string[] = [];
  if (sessionKnowledge.decisions.length > 0) {
    const decisions = sessionKnowledge.decisions
      .map(d => `- ${d.decision} (${d.rationale})`)
      .join('\n');
    knowledge.push(`## Prior Decisions\n${decisions}`);
  }
  if (sessionKnowledge.deadEnds.length > 0) {
    const deadEnds = sessionKnowledge.deadEnds
      .map(d => `- ${d.approach}: ${d.reason}`)
      .join('\n');
    knowledge.push(`## Dead Ends (do NOT retry)\n${deadEnds}`);
  }
  if (knowledge.length > 0) {
    sections.push(`# Session Knowledge\n${knowledge.join('\n\n')}`);
  }

  // ── Constraints ──
  sections.push(
    `# Constraints\n` +
    `- Mutation budget: 2 consecutive edits without test = blocked, 10 total across graph.\n` +
    `- 2-attempt cap: after 2 failed attempts, escalate.\n` +
    `- Context gate: if turn count > 40, end with result "partial".`,
  );

  return sections.join('\n\n');
}
