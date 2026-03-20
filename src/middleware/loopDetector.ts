import OpenAI from 'openai';
import type { LlmCallFn, LlmMessage, Middleware } from '../types/index.js';
import { LoopDetectedError } from '../types/index.js';

export interface LoopDetectorConfig {
  /** Number of recent embeddings to retain for comparison. Default: 8. */
  windowSize?: number;
  /** Mean cosine similarity threshold above which a turn is considered high-similarity. Default: 0.92. */
  similarityThreshold?: number;
  /** Number of consecutive high-similarity turns required to fire LoopDetectedError. Default: 5. */
  consecutiveTurns?: number;
  /** Optional callback fired when a high-similarity turn is detected but threshold not yet reached. */
  onWarning?: (meanSimilarity: number, consecutiveCount: number) => void;
}

/**
 * Compute dot product of two same-length vectors.
 * Because OpenAI text-embedding-3-small embeddings are pre-normalized (unit vectors),
 * dot product equals cosine similarity.
 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Compute the mean cosine similarity between a new embedding and all embeddings in the window.
 * Returns 0 if window is empty.
 */
function meanSimilarity(embedding: number[], window: number[][]): number {
  if (window.length === 0) return 0;
  const total = window.reduce((acc, w) => acc + dotProduct(embedding, w), 0);
  return total / window.length;
}

/**
 * Extract the last user message content from a message array.
 * Returns null if no user message is found.
 */
function lastUserMessage(messages: LlmMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return null;
}

/**
 * Factory that creates a loop-detector middleware.
 *
 * The middleware:
 * 1. Fires BEFORE the LLM call (checks the input messages).
 * 2. Embeds the last user message using text-embedding-3-small.
 * 3. Computes mean cosine similarity against a rolling window of recent embeddings.
 * 4. Tracks consecutive turns where mean similarity exceeds the threshold.
 * 5. Throws LoopDetectedError when the consecutive count reaches the limit.
 * 6. On embedding API failure: logs a warning, skips the check, resets the consecutive counter.
 *
 * No cross-run state — every call to createLoopDetector produces a fresh closure.
 */
export function createLoopDetector(config: LoopDetectorConfig = {}): Middleware {
  const windowSize = config.windowSize ?? 8;
  const similarityThreshold = config.similarityThreshold ?? 0.92;
  const consecutiveTurns = config.consecutiveTurns ?? 5;
  const onWarning = config.onWarning;

  // Per-run state — lives entirely inside this closure.
  const embeddingWindow: number[][] = [];
  const rawMessageWindow: string[] = [];
  let consecutiveHighSimilarityCount = 0;

  const openai = new OpenAI(); // reads OPENAI_API_KEY automatically

  return (next: LlmCallFn): LlmCallFn => {
    return async (messages, options) => {
      // ── Step 1: extract the message we will embed ────────────────────────
      const userMessage = lastUserMessage(messages);

      if (userMessage !== null) {
        // ── Step 2: maintain raw message window (for diagnostics) ───────────
        rawMessageWindow.push(userMessage);
        if (rawMessageWindow.length > windowSize) {
          rawMessageWindow.shift();
        }

        // ── Step 3: embed ────────────────────────────────────────────────────
        let embedding: number[] | null = null;
        try {
          const response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: userMessage,
          });
          embedding = response.data[0].embedding;
        } catch (err) {
          console.warn(
            '[loopDetector] Embedding API call failed; skipping similarity check for this turn.',
            err instanceof Error ? err.message : String(err)
          );
          // Reset consecutive counter per spec: "resets consecutive counter" on failure.
          consecutiveHighSimilarityCount = 0;
        }

        if (embedding !== null) {
          // ── Step 4: similarity check (only once window has >= 2 embeddings) ─
          if (embeddingWindow.length >= 1) {
            // window already has at least 1 entry; adding this one makes >= 2
            const mean = meanSimilarity(embedding, embeddingWindow);

            if (mean >= similarityThreshold) {
              consecutiveHighSimilarityCount++;

              if (onWarning) {
                onWarning(mean, consecutiveHighSimilarityCount);
              }

              if (consecutiveHighSimilarityCount >= consecutiveTurns) {
                throw new LoopDetectedError(
                  mean,
                  consecutiveHighSimilarityCount,
                  [...rawMessageWindow]
                );
              }
            } else {
              // Similarity is below threshold — reset the streak.
              consecutiveHighSimilarityCount = 0;
            }
          }
          // embeddingWindow has < 1 entry (i.e., this is the very first turn):
          // no check, just add to window below.

          // ── Step 5: add new embedding to rolling window ──────────────────
          embeddingWindow.push(embedding);
          if (embeddingWindow.length > windowSize) {
            embeddingWindow.shift();
          }
        }
      }

      // ── Step 6: pass through to next middleware / base LLM call ──────────
      return next(messages, options);
    };
  };
}
