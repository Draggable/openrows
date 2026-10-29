import { ProblemDetailsSchema } from '@openrows/shared';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testApp } from '../../test/helpers/app.js';
import { AppError, codeForStatus } from './errors.js';

function appThrowing(err: unknown) {
  const t = testApp();
  t.app.get('/boom', () => {
    throw err;
  });
  return t;
}

async function problemOf(res: Response) {
  expect(res.headers.get('content-type')).toBe('application/problem+json');
  const body = ProblemDetailsSchema.parse(await res.json());
  expect(body.requestId).toBe(res.headers.get('x-request-id'));
  expect(body.status).toBe(res.status);
  return body;
}

describe('global error handler', () => {
  it('hides the message of unexpected errors and logs it with the request id', async () => {
    const { app, logs } = appThrowing(new Error('db password is hunter2'));
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await problemOf(res);
    expect(body).toMatchObject({
      type: 'https://openrows.io/problems/internal-error',
      title: 'Internal server error',
      code: 'INTERNAL_ERROR',
      instance: '/boom',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    const logged = logs.find((l) => l['msg'] === 'unhandled error');
    expect(logged).toMatchObject({ level: 'error', requestId: body.requestId });
  });

  it('maps AppError to its catalog entry with detail and extensions', async () => {
    const { app } = appThrowing(
      new AppError('CONFLICT', { detail: 'Name taken', extensions: { field: 'name' } })
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: 'CONFLICT',
      title: 'Conflict',
      detail: 'Name taken',
      field: 'name',
    });
  });

  it('maps ZodError to VALIDATION_FAILED with field errors', async () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 1 });
    const { app } = appThrowing(result.error);
    const res = await app.request('/boom');
    expect(res.status).toBe(422);
    const body = await problemOf(res);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors).toEqual([{ path: 'name', message: expect.any(String) }]);
  });

  it('maps HTTPException by status and keeps its headers', async () => {
    const { app } = appThrowing(
      new HTTPException(401, {
        message: 'Session expired',
        res: new Response('x', { headers: { 'WWW-Authenticate': 'Bearer' } }),
      })
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await problemOf(res)).toMatchObject({
      code: 'UNAUTHENTICATED',
      detail: 'Session expired',
    });
  });

  it('returns NOT_FOUND for unknown routes', async () => {
    const { app } = testApp();
    const res = await app.request('/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await problemOf(res)).toMatchObject({ code: 'NOT_FOUND', instance: '/nope' });
  });
});

describe('codeForStatus', () => {
  it('finds catalog codes and falls back by class', () => {
    expect(codeForStatus(413)).toBe('PAYLOAD_TOO_LARGE');
    expect(codeForStatus(418)).toBe('BAD_REQUEST');
    expect(codeForStatus(502)).toBe('INTERNAL_ERROR');
  });
});

describe('problem extensions', () => {
  it('cannot overwrite standard members', async () => {
    const { app } = appThrowing(
      new AppError('FORBIDDEN', {
        extensions: { status: 200, requestId: 'forged', role: 'viewer' },
      })
    );
    const res = await app.request('/boom');
    const body = await problemOf(res);
    expect(body).toMatchObject({ status: 403, role: 'viewer' });
    expect(body.requestId).not.toBe('forged');
  });
});
