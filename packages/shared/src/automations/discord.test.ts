import { describe, expect, it } from 'vitest';
import {
  DISCORD_WEBHOOK_HOSTS,
  discordPayload,
  discordWebhookUrlProblem,
  MAX_DISCORD_CONTENT,
  MAX_DISCORD_EMBED_DESCRIPTION,
  MAX_DISCORD_EMBED_TITLE,
  MAX_DISCORD_USERNAME,
  truncateText,
} from './discord.js';

describe('Discord webhook URLs', () => {
  it('accepts the webhook path on each Discord host', () => {
    for (const host of DISCORD_WEBHOOK_HOSTS) {
      expect(discordWebhookUrlProblem(`https://${host}/api/webhooks/1/t`)).toBeNull();
      expect(discordWebhookUrlProblem(`https://${host}/api/v10/webhooks/1/t`)).toBeNull();
    }
  });

  it('refuses other hosts and IP literals', () => {
    for (const url of [
      'https://discord.com.evil.example/api/webhooks/1/t',
      'https://10.0.0.1/api/webhooks/1/t',
      'https://[fd00::1]/api/webhooks/1/t',
    ]) {
      expect(discordWebhookUrlProblem(url)).toMatch(/is on discord\.com/);
    }
  });
});

describe('truncateText', () => {
  it('keeps short texts and cuts long ones with an ellipsis', () => {
    expect(truncateText('abc', 3)).toBe('abc');
    expect(truncateText('abcd', 3)).toBe('ab…');
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateText(`a${'😀'.repeat(5)}`, 3);
    expect(cut).toBe('a…');
    expect(cut.length).toBeLessThanOrEqual(3);
  });
});

describe('discordPayload', () => {
  it('sends the text and parses no mentions by default', () => {
    expect(discordPayload({ text: ' Hi @everyone ', mentions: [] })).toEqual({
      content: 'Hi @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('allows only the mentions the step lists, in a fixed order', () => {
    expect(discordPayload({ text: 'x', mentions: ['everyone', 'users'] }).allowed_mentions).toEqual(
      { parse: ['users', 'everyone'] }
    );
  });

  it('sends a display name and one embed with its colour as a number', () => {
    expect(
      discordPayload({
        text: '',
        username: 'Bot',
        embed: { title: 'T', description: 'D', url: 'https://example.com/x', color: '#5865F2' },
        mentions: [],
      })
    ).toEqual({
      username: 'Bot',
      embeds: [{ title: 'T', description: 'D', url: 'https://example.com/x', color: 0x5865f2 }],
      allowed_mentions: { parse: [] },
    });
  });

  it("cuts filled-in values to Discord's limits", () => {
    const long = (n: number) => 'y'.repeat(n + 50);
    const p = discordPayload({
      text: long(MAX_DISCORD_CONTENT),
      username: long(MAX_DISCORD_USERNAME),
      embed: {
        title: long(MAX_DISCORD_EMBED_TITLE),
        description: long(MAX_DISCORD_EMBED_DESCRIPTION),
      },
      mentions: [],
    });
    expect(p.content?.length).toBe(MAX_DISCORD_CONTENT);
    expect(p.content?.endsWith('…')).toBe(true);
    expect(p.username?.length).toBe(MAX_DISCORD_USERNAME);
    expect(p.embeds?.[0]?.title?.length).toBe(MAX_DISCORD_EMBED_TITLE);
    expect(p.embeds?.[0]?.description?.length).toBe(MAX_DISCORD_EMBED_DESCRIPTION);
  });

  it('leaves out an embed that is empty once filled in, and fails when nothing is left', () => {
    expect(
      discordPayload({ text: 'x', embed: { title: ' ', color: '#000000' }, mentions: [] })
    ).toEqual({ content: 'x', allowed_mentions: { parse: [] } });
    expect(() => discordPayload({ text: '  ', embed: { title: '' }, mentions: [] })).toThrow(
      'The message is empty'
    );
  });

  it('fails on an embed link that is not an http(s) URL once filled in', () => {
    expect(() =>
      discordPayload({ text: 'x', embed: { title: 'T', url: 'javascript:x' }, mentions: [] })
    ).toThrow('http or https');
  });
});
