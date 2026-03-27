/**
 * CouplingAudit — Hybrid coupling classification (static + LLM semantic).
 *
 * Phase 1: Static analysis scans for imports, shared variables, function calls.
 * Phase 2: LLM classifies control/common/content coupling with confidence scores.
 */

import type { LlmCallFn } from '../types/index.js';
import type { DependencyEdge } from '../types/graph.js';

export interface CouplingResult {
  couplingType: 'data' | 'stamp' | 'control' | 'common' | 'content';
  couplingSource: 'static' | 'llm-inferred' | 'hybrid';
  couplingConfidence: number;
  detail: string;
}

// ─── Phase 1: Static analysis ───

const IMPORT_PATTERNS = [
  /import\s+.*\s+from\s+['"]([^'"]+)['"]/g,         // ESM import
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,           // CommonJS require
  /from\s+(\S+)\s+import/g,                           // Python
];

const SHARED_STATE_PATTERNS = [
  /(?:let|var)\s+\w+\s*=/,                            // Mutable module-level variable
  /global\s+\w+/,                                      // Python global
  /export\s+(?:let|var)\s+\w+/,                        // Exported mutable
];

export function analyzeStaticCoupling(
  fromPaths: string[],
  toPaths: string[],
  projectFiles: Record<string, string>,
): CouplingResult {
  const fromContents = fromPaths.map(p => projectFiles[p] ?? '').join('\n');
  const toContents = toPaths.map(p => projectFiles[p] ?? '').join('\n');

  // Check for direct imports between file sets
  const toModules = new Set(toPaths.map(p => p.replace(/\.[^.]+$/, '')));
  let hasImport = false;
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(fromContents)) !== null) {
      const imported = match[1]!;
      for (const mod of toModules) {
        if (imported.includes(mod) || mod.includes(imported)) {
          hasImport = true;
          break;
        }
      }
    }
  }

  // Check for shared mutable state
  const hasSharedState = SHARED_STATE_PATTERNS.some(
    p => p.test(fromContents) && p.test(toContents)
  );

  // Check for struct/object passing (stamp coupling indicator)
  const hasObjectPassing = /(?:interface|type|class|struct)\s+\w+/.test(fromContents) &&
    /(?:interface|type|class|struct)\s+\w+/.test(toContents);

  if (hasSharedState) {
    return {
      couplingType: 'common',
      couplingSource: 'static',
      couplingConfidence: 0.85,
      detail: 'Shared mutable state detected between file sets',
    };
  }

  if (hasObjectPassing && hasImport) {
    return {
      couplingType: 'stamp',
      couplingSource: 'static',
      couplingConfidence: 0.8,
      detail: 'Composite types passed between modules via imports',
    };
  }

  if (hasImport) {
    return {
      couplingType: 'data',
      couplingSource: 'static',
      couplingConfidence: 0.9,
      detail: 'Direct import dependency between file sets',
    };
  }

  return {
    couplingType: 'data',
    couplingSource: 'static',
    couplingConfidence: 0.5,
    detail: 'No direct coupling detected statically (may exist semantically)',
  };
}

// ─── Phase 2: LLM semantic classification ───

export async function classifyCouplingSemantic(
  edge: DependencyEdge,
  nodeDescriptions: { from: string; to: string },
  llmCall: LlmCallFn,
): Promise<CouplingResult> {
  const prompt = `Classify the software coupling type between these two modules:

Module A: ${nodeDescriptions.from}
Module B: ${nodeDescriptions.to}
Edge type: ${edge.type}

Coupling types (from least to most dangerous):
1. data - Simple parameter passing
2. stamp - Shared composite data structures (only part of fields used)
3. control - One module controls behavior of another via flags/parameters
4. common - Shared global/mutable state
5. content - Direct access to internal implementation of another module

Respond with ONLY a JSON object: { "couplingType": string, "confidence": number, "detail": string }
confidence should be 0.0-1.0.`;

  try {
    const response = await llmCall(
      [{ role: 'user', content: prompt }],
      { maxTokens: 200, temperature: 0.1 },
    );

    const parsed = JSON.parse(response.content) as {
      couplingType: CouplingResult['couplingType'];
      confidence: number;
      detail: string;
    };

    return {
      couplingType: parsed.couplingType,
      couplingSource: 'llm-inferred',
      couplingConfidence: parsed.confidence,
      detail: parsed.detail,
    };
  } catch {
    return {
      couplingType: 'data',
      couplingSource: 'llm-inferred',
      couplingConfidence: 0.3,
      detail: 'LLM coupling classification failed — defaulting to data coupling',
    };
  }
}

// ─── Combined audit ───

export async function auditCoupling(
  edge: DependencyEdge,
  context: {
    projectFiles?: Record<string, string>;
    llmCall: LlmCallFn;
    nodeDescriptions: { from: string; to: string };
    fromPaths?: string[];
    toPaths?: string[];
  },
): Promise<CouplingResult> {
  // If we have project files and paths, do static analysis first
  if (context.projectFiles && context.fromPaths && context.toPaths) {
    const staticResult = analyzeStaticCoupling(
      context.fromPaths,
      context.toPaths,
      context.projectFiles,
    );

    // If static analysis is confident, use it directly
    if (staticResult.couplingConfidence >= 0.8) {
      return staticResult;
    }

    // Otherwise, supplement with LLM classification
    const llmResult = await classifyCouplingSemantic(
      edge,
      context.nodeDescriptions,
      context.llmCall,
    );

    // Hybrid: use the higher-confidence result, but note hybrid source
    if (llmResult.couplingConfidence > staticResult.couplingConfidence) {
      return {
        ...llmResult,
        couplingSource: 'hybrid',
        couplingConfidence: Math.max(staticResult.couplingConfidence, llmResult.couplingConfidence),
      };
    }

    return {
      ...staticResult,
      couplingSource: 'hybrid',
    };
  }

  // No project files — LLM only
  return classifyCouplingSemantic(edge, context.nodeDescriptions, context.llmCall);
}
