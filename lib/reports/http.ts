import 'server-only';

import { RunStateError } from 'report-engine';

import { getProfile } from '@/lib/session';

import { ReportsNotConfigured } from './env';
import type { Owner } from './store';

/** The JSON error every report route answers with. */
export function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

const MAX_BODY_BYTES = 16_384;

/**
 * Reads a small JSON object body. Requiring JSON also keeps a cross-site form
 * from starting a run: a form can't send this content type without a preflight.
 */
export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return problem(415, 'unsupported_media_type', 'Send JSON.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return problem(413, 'too_large', 'The request is too large.');
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  return problem(400, 'bad_request', 'Send a JSON object.');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isRunId = (value: string) => UUID.test(value);

export type Signed = NonNullable<Awaited<ReturnType<typeof getProfile>>> & { owner: Owner };

/** The signed-in, allow-listed person, or the 401 to send. */
export async function signedIn(): Promise<Signed | Response> {
  const context = await getProfile();
  if (!context) return problem(401, 'unauthorized', 'Sign in to use reports.');
  return { ...context, owner: { ownerId: context.user.id, groupId: context.profile.group_id } };
}

const STATUS_OF_CODE: Record<RunStateError['code'], number> = {
  bad_request: 400,
  wrong_status: 409,
  plan_changed: 409,
  expired: 410,
};

/** Maps what a route can expect to go wrong to a response; anything else is a 500. */
export function failure(error: unknown, context: string): Response {
  if (error instanceof RunStateError) return problem(STATUS_OF_CODE[error.code], error.code, error.message);
  if (error instanceof ReportsNotConfigured) return problem(503, 'not_configured', error.message);
  console.error(`${context}:`, error);
  return problem(500, 'internal', 'Something went wrong. Try again in a moment.');
}
