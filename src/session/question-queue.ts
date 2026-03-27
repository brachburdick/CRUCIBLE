/**
 * Question Queue — async decision-making without blocking the pipeline.
 *
 * When a node encounters ambiguity, it writes a question instead of blocking.
 * The pipeline continues to the next ready node/task. Answers are picked up
 * on the next run and integrated via the readiness gate.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Question, QuestionStatus } from './types.js';

const QUESTIONS_FILENAME = 'questions.jsonl';

export class QuestionQueue {
  private questions: Map<string, Question> = new Map();
  private readonly questionsPath: string;

  constructor(private readonly agentDir: string) {
    this.questionsPath = path.join(agentDir, QUESTIONS_FILENAME);
  }

  /** Load all questions from .agent/questions.jsonl. */
  async load(): Promise<Question[]> {
    this.questions.clear();
    try {
      const raw = await fs.readFile(this.questionsPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const question = JSON.parse(line) as Question;
        this.questions.set(question.id, question);
      }
    } catch {
      // No questions file yet.
    }
    return this.all();
  }

  /** Persist all questions back to disk. */
  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.questionsPath), { recursive: true });
    const lines = Array.from(this.questions.values()).map(q => JSON.stringify(q));
    await fs.writeFile(this.questionsPath, lines.join('\n') + '\n', 'utf-8');
  }

  /** Get all questions. */
  all(): Question[] {
    return Array.from(this.questions.values());
  }

  /** Get a question by ID. */
  get(id: string): Question | undefined {
    return this.questions.get(id);
  }

  /**
   * Ask a new question. The pipeline does not block — it moves to
   * the next ready task. The operator answers async.
   */
  ask(question: Omit<Question, 'status' | 'asked' | 'answered' | 'answer'>): Question {
    const full: Question = {
      ...question,
      status: 'pending',
      asked: new Date().toISOString(),
      answered: null,
      answer: null,
    };
    this.questions.set(full.id, full);
    return full;
  }

  /**
   * Record an answer to a pending question.
   */
  answer(questionId: string, answer: string): Question {
    const question = this.questions.get(questionId);
    if (!question) {
      throw new Error(`Question not found: ${questionId}`);
    }
    if (question.status !== 'pending') {
      throw new Error(`Question ${questionId} is not pending (status: ${question.status})`);
    }
    question.status = 'answered';
    question.answered = new Date().toISOString();
    question.answer = answer;
    return question;
  }

  /** Get all pending questions. */
  pending(): Question[] {
    return this.all().filter(q => q.status === 'pending');
  }

  /** Get all answered questions (for loading into session context). */
  answered(): Question[] {
    return this.all().filter(q => q.status === 'answered');
  }

  /** Get questions related to a specific task. */
  forTask(taskId: string): Question[] {
    return this.all().filter(q => q.task === taskId);
  }

  /** Get newly answered questions (answered but not yet consumed by a session). */
  newlyAnswered(knownAnsweredIds: Set<string>): Question[] {
    return this.answered().filter(q => !knownAnsweredIds.has(q.id));
  }
}
