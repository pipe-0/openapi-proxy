import { DocumentTooComplexError } from "./limits.js";

/**
 * A budget of work for one job the engine is given.
 *
 * Limits on a document's size bound what one pass over it costs. They do not
 * bound how often a part of it is passed over: a small document can be made
 * so that something in it is read again from every place that mentions it,
 * and then it costs the square of its size. So the work itself is counted,
 * in steps: one for every value looked at, and one for every
 * `CHARACTERS_PER_STEP` characters of text read. Whatever in the engine goes
 * over what a document holds spends steps for it, and a job that runs out
 * stops with a `DocumentTooComplexError`.
 *
 * A job is whatever `withBudget` is put around: a single call into the
 * engine, or everything a request needs done (parsing a project's sources,
 * assembling them, cutting a variant out and writing it).
 *
 * The number is about four times what the largest project this service
 * accepts takes to render, five megabytes of sources: see the calibration in
 * test/cost.test.ts, which also holds the engine to what a step is supposed
 * to cost.
 *
 * It is module state, which is safe because the engine is synchronous: one
 * job runs from start to finish before anything else does.
 */
export const WORK_BUDGET = 20_000_000;

/** Reading text is cheaper than looking at values: this many characters make a step. */
const CHARACTERS_PER_STEP_LOG2 = 5;

let remaining: number | undefined;

/**
 * Run `work` with a budget. A call made while another is under way shares
 * that one's budget: what counts is the whole of what was asked for.
 */
export function withBudget<T>(work: () => T): T {
  if (remaining !== undefined) return work();
  remaining = WORK_BUDGET;
  try {
    return work();
  } finally {
    remaining = undefined;
  }
}

/** Count `steps` of work. Outside `withBudget` nothing is counted. */
export function spend(steps = 1): void {
  if (remaining === undefined) return;
  remaining -= steps;
  if (remaining < 0) {
    throw new DocumentTooComplexError(
      "too-much-work",
      "Working on this document takes more steps than are allowed. It repeats or nests something in a way that multiplies the work.",
    );
  }
}

/** Count the reading (or writing) of `length` characters. */
export function spendText(length: number): void {
  spend(1 + (length >>> CHARACTERS_PER_STEP_LOG2));
}

/** Steps left in the job under way, for tests that want to know what something cost. */
export function budgetLeft(): number | undefined {
  return remaining;
}
