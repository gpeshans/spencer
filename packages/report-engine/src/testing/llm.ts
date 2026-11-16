import { ZERO_USAGE, type GenerateRequest, type GenerateResult, type LlmCallRecord, type LlmFailureCode, type LlmProvider } from '../llm';

/** One call record, as a provider would report it: 100 tokens in, 50 out, one cent. */
export function callRecord(stage: string): LlmCallRecord {
  return {
    stage,
    attempt: 1,
    provider: 'test',
    modelRequested: 'test-model',
    modelServed: 'test-model',
    fallbackReason: null,
    effort: 'low',
    usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50 },
    costUsd: 0.01,
    latencyMs: 5,
    ttftMs: null,
    stopReason: 'end_turn',
    requestId: null,
    errorClass: null,
  };
}

export type ScriptedAnswer = { output: unknown } | { fails: LlmFailureCode };

/**
 * An LLM that gives scripted answers in order. Each answer is checked against
 * the request's own schema, as the real provider does, so a test can't feed a
 * stage an answer the API would never return.
 */
export function scriptedLlm(answers: ScriptedAnswer[]) {
  const requests: GenerateRequest<unknown>[] = [];
  const llm: LlmProvider = {
    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      requests.push(request as GenerateRequest<unknown>);
      const answer = answers.shift();
      if (!answer) throw new Error(`no scripted answer for ${request.stage}`);
      const calls = [callRecord(request.stage)];
      if ('fails' in answer) return { ok: false, error: { code: answer.fails, message: `stub: ${answer.fails}` }, calls };
      const parsed = request.schema.safeParse(answer.output);
      if (!parsed.success) throw new Error(`the scripted ${request.stage} answer breaks its schema: ${parsed.error.message}`);
      return { ok: true, output: parsed.data, calls };
    },
  };
  return { llm, requests };
}
