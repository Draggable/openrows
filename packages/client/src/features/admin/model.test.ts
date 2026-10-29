import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { adminReauthHref, consoleState, minutesLeft, planRequest } from './model';

describe('ops console model', () => {
  it('asks for a fresh sign-in that returns to the console', () => {
    const url = new URL(adminReauthHref(), 'http://app.test');
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('reauth')).toBe('1');
    expect(url.searchParams.get('returnTo')).toBe('/admin');
  });

  it('reads 404 as no console and REAUTHENTICATION_REQUIRED as a sign-in prompt', () => {
    expect(consoleState(new ApiError(404, 'Not found'))).toBe('unavailable');
    expect(consoleState(new ApiError(403, 'x', null, 'REAUTHENTICATION_REQUIRED'))).toBe('reauth');
    expect(consoleState(new ApiError(500, 'x'))).toBe('error');
    expect(consoleState(new Error('x'))).toBe('error');
  });

  it('turns a plan draft into a request', () => {
    expect(planRequest({ plan: ' pro ', overrides: '' })).toEqual({
      body: { plan: 'pro', overrides: {} },
    });
    expect(planRequest({ plan: '', overrides: '{"limits":{"recordsPerBase":10}}' })).toEqual({
      body: { plan: null, overrides: { limits: { recordsPerBase: 10 } } },
    });
    expect(planRequest({ plan: 'pro', overrides: '{' })).toEqual({
      problem: 'Overrides must be JSON.',
    });
    expect(planRequest({ plan: 'pro', overrides: '{"x":1}' })).toHaveProperty('problem');
  });

  it('counts the minutes left', () => {
    expect(minutesLeft(new Date(90_000).toISOString(), 0)).toBe(2);
    expect(minutesLeft(new Date(0).toISOString(), 60_000)).toBe(0);
  });
});
