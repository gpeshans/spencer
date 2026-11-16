import { RunStateError } from 'report-engine';
import { describe, expect, it, vi } from 'vitest';

import { ReportsNotConfigured } from './env';
import { failure, isRunId, readJson } from './http';

const post = (body: string, type = 'application/json') =>
  new Request('http://localhost/api/reports/runs', { method: 'POST', headers: { 'content-type': type }, body });

async function errorOf(response: Response | Record<string, unknown>) {
  if (!(response instanceof Response)) throw new Error('expected an error response');
  return { status: response.status, ...((await response.json()) as { error: { code: string } }).error };
}

describe('readJson', () => {
  it('reads a JSON object, and treats an empty body as one', async () => {
    expect(await readJson(post('{"request":"Spending last month"}'))).toEqual({ request: 'Spending last month' });
    expect(await readJson(post(''))).toEqual({});
  });

  it('only takes JSON, so a cross-site form cannot post here', async () => {
    expect(await errorOf(await readJson(post('request=x', 'application/x-www-form-urlencoded')))).toMatchObject({
      status: 415,
      code: 'unsupported_media_type',
    });
  });

  it('rejects bodies that are too large or not an object', async () => {
    expect(await errorOf(await readJson(post(JSON.stringify({ request: 'x'.repeat(20_000) }))))).toMatchObject({ status: 413 });
    expect(await errorOf(await readJson(post('[1,2]')))).toMatchObject({ status: 400, code: 'bad_request' });
    expect(await errorOf(await readJson(post('{oops')))).toMatchObject({ status: 400 });
  });
});

describe('failure', () => {
  it('maps the engine and configuration errors to their statuses', async () => {
    expect(await errorOf(failure(new RunStateError('plan_changed', 'The plan changed.'), 'test'))).toMatchObject({
      status: 409,
      code: 'plan_changed',
    });
    expect(await errorOf(failure(new RunStateError('expired', 'Expired.'), 'test'))).toMatchObject({ status: 410 });
    expect(await errorOf(failure(new ReportsNotConfigured(['SUPABASE_SECRET_KEY is missing']), 'test'))).toMatchObject({
      status: 503,
      code: 'not_configured',
      message: "Reports aren't set up: SUPABASE_SECRET_KEY is missing.",
    });
  });

  it('answers anything else with a 500 that says nothing about the cause, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await errorOf(failure(new Error('duplicate key value (id)=(secret)'), 'test'))).toEqual({
      status: 500,
      code: 'internal',
      message: 'Something went wrong. Try again in a moment.',
    });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe('isRunId', () => {
  it('accepts lowercase UUIDs only', () => {
    expect(isRunId('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f')).toBe(true);
    expect(isRunId('3F0C7A52-6B1E-4D2A-9C8E-1B2A3C4D5E6F')).toBe(false);
    expect(isRunId('../etc')).toBe(false);
  });
});
