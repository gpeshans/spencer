import { canTransition } from '../core/run-status';
import { addUsage, type LlmCallRecord } from '../llm';
import type { RunStage, RunState } from './state';

/**
 * The bookkeeping every pipeline step shares: each change goes through
 * `canTransition` and is saved; LLM usage is added up; time is measured per
 * stage, adding to earlier rounds.
 */
export interface Tracker {
  readonly state: RunState;
  update(patch: Partial<RunState>): Promise<void>;
  /** Starts timing `stage` and saves the state with it. */
  enter(stage: RunStage, patch?: Partial<RunState>): Promise<void>;
  /** Adds the time since `enter` to the current stage. The next save stores it. */
  finishStage(): void;
  /** Adds the calls' tokens and cost. The next save stores them. */
  account(calls: readonly LlmCallRecord[]): void;
  /** Finishes the stage, then saves the run as failed. */
  fail(stage: RunStage, code: string, message: string, details?: string[]): Promise<RunState>;
}

export function track(initial: RunState, save: (state: RunState) => Promise<void>): Tracker {
  let state = initial;
  let started: number | null = null;

  const update = async (patch: Partial<RunState>) => {
    const status = patch.status ?? state.status;
    if (status !== state.status && !canTransition(state.status, status)) {
      throw new Error(`run ${state.id}: ${state.status} → ${status} is not a valid transition`);
    }
    state = { ...state, ...patch };
    await save(state);
  };

  const finishStage = () => {
    if (started === null || !state.stage) return;
    const spent = Math.round(performance.now() - started);
    started = null;
    state = { ...state, stageTimings: { ...state.stageTimings, [state.stage]: (state.stageTimings[state.stage] ?? 0) + spent } };
  };

  return {
    get state() {
      return state;
    },
    update,
    async enter(stage, patch = {}) {
      finishStage();
      started = performance.now();
      await update({ stage, ...patch });
    },
    finishStage,
    account(calls) {
      for (const call of calls) {
        state = { ...state, usage: addUsage(state.usage, call.usage), costUsd: state.costUsd + call.costUsd };
      }
    },
    async fail(stage, code, message, details) {
      finishStage();
      await update({ status: 'failed', error: { stage, code, message, ...(details && { details }) } });
      return state;
    },
  };
}
