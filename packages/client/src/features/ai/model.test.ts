import type { AiSettings } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  choosePreset,
  formProblem,
  initialForm,
  keyRequired,
  presetFor,
  sourceText,
  toRequest,
} from './model';

const stored = (baseUrl = 'https://api.openai.com/v1'): AiSettings => ({
  workspaceId: 'w',
  source: 'workspace',
  instance: { available: false, model: null },
  workspace: { baseUrl, model: 'gpt-4.1-mini', hasKey: true, updatedAt: '2026-10-28T00:00:00Z' },
  allowedHosts: null,
});

describe('the AI settings form (#148)', () => {
  it('starts from OpenAI without settings, and from the stored ones', () => {
    expect(initialForm(undefined)).toEqual({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      apiKey: '',
    });
    expect(initialForm(stored('http://ollama:11434/v1'))).toMatchObject({
      preset: 'custom',
      baseUrl: 'http://ollama:11434/v1',
      apiKey: '',
    });
    expect(presetFor('https://openrouter.ai/api/v1/')).toBe('openrouter');
  });

  it('fills a preset, and keeps a custom URL while staying custom', () => {
    const custom = choosePreset(initialForm(undefined), 'custom');
    expect(custom.baseUrl).toBe('');
    expect(choosePreset({ ...custom, baseUrl: 'http://x/v1' }, 'custom').baseUrl).toBe(
      'http://x/v1'
    );
    expect(choosePreset(custom, 'anthropic')).toMatchObject({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-haiku-5-5',
    });
  });

  it('needs the key without a stored one or for a new URL', () => {
    const form = initialForm(stored());
    expect(keyRequired(form, stored())).toBe(false);
    expect(formProblem(form, stored())).toBeNull();
    const moved = choosePreset(form, 'openrouter');
    expect(keyRequired(moved, stored())).toBe(true);
    expect(formProblem(moved, stored())).toBe('Enter an API key.');
    expect(formProblem({ ...form, model: ' ' }, stored())).toBe('Enter a model.');
    expect(formProblem({ ...form, baseUrl: 'nope' }, stored())).toBe('Enter the API base URL.');
    expect(formProblem(initialForm(undefined), undefined)).toBe('Enter an API key.');
  });

  it('sends the key only when typed', () => {
    const form = initialForm(stored());
    expect(toRequest({ ...form, baseUrl: 'https://api.openai.com/v1/' })).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
    expect(toRequest({ ...form, apiKey: ' sk-1234567890 ' }).apiKey).toBe('sk-1234567890');
  });

  it('says where AI comes from', () => {
    expect(sourceText(stored())).toMatch(/own key/);
    expect(
      sourceText({ ...stored(), source: 'instance', instance: { available: true, model: 'm' } })
    ).toMatch(/this server's provider \(m\)/);
    expect(sourceText({ ...stored(), source: null })).toMatch(/AI is off/);
  });

  it("says how many of the month's AI credits the hosted provider used (#151)", () => {
    const hosted = (used: number) =>
      sourceText({
        ...stored(),
        source: 'instance',
        instance: {
          available: true,
          model: 'm',
          credits: { used, limit: 1000, resetsOn: '2026-11-01' },
        },
      });
    expect(hosted(120)).toMatch(
      /OpenRows' AI provider \(m\)\. 120 of this month's 1,000 AI credits used/
    );
    expect(hosted(1000)).toMatch(/used up until November 1/);
    expect(hosted(1000)).toMatch(/don't use credits/);
  });
});
