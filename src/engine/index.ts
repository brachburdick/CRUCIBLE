export { RunEngine, type RunEvent } from './RunEngine.js';
export { baseLlmCall } from './llm.js';
export { validateTaskPayload } from './validation.js';
export { AGENTS, getAgentNames } from './agents.js';

// Phase 0: Graph data model + storage
export { GraphStore } from './GraphStore.js';
export { GraphBuilder } from './GraphBuilder.js';

// Phase 1: Readiness gate
export { ReadinessGate } from './ReadinessGate.js';
export { generateQuestions, preflight } from './QuestionGenerator.js';

// Phase 2: Decomposition engine
export { DecompositionEngine } from './DecompositionEngine.js';
export type { DecompositionStrategy, DecompositionContext, DecompositionStrategyConfig } from './DecompositionEngine.js';
export { estimateComplexity } from './ComplexityEstimator.js';
export { analyzeStaticCoupling, classifyCouplingSemantic, auditCoupling } from './CouplingAudit.js';
export { shouldStopDecomposing } from './AdaptiveBounds.js';

// Strategies
export { D0Strategy } from './strategies/D0Strategy.js';
export { D4Strategy } from './strategies/D4Strategy.js';
export { D5Strategy } from './strategies/D5Strategy.js';

// Extended variant loading
export { loadExtendedVariant } from './variants.js';
export type { ExtendedVariantConfig } from './variants.js';

// Phase 2.5: Session model
export { SessionModel } from '../session/index.js';
export type { SessionModelConfig } from '../session/index.js';
