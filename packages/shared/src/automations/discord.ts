/**
 * The Send Discord message action's rules: which webhook URLs it posts to, Discord's limits,
 * and the JSON it sends (a webhook's "execute" body).
 */

/** The hosts a Discord channel webhook URL may be on. */
export const DISCORD_WEBHOOK_HOSTS = [
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
] as const;

/**
 * A whole Discord webhook URL: https, one of DISCORD_WEBHOOK_HOSTS (no port, credentials or
 * trailing dot), `/api/webhooks/<id>/<token>` or `/api/v<N>/webhooks/<id>/<token>`, nothing
 * after it. Matched on the whole string, so the URL sent is the URL checked.
 */
const DISCORD_WEBHOOK_URL =
  /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api(?:\/v\d{1,2})?\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,200}$/;

/** Discord's limits, in characters. */
export const MAX_DISCORD_CONTENT = 2000;
export const MAX_DISCORD_USERNAME = 80;
export const MAX_DISCORD_EMBED_TITLE = 256;
export const MAX_DISCORD_EMBED_DESCRIPTION = 4096;
export const MAX_DISCORD_EMBED_URL = 2000;

/**
 * Who a message may notify (Discord's `allowed_mentions.parse`): mentioned users, mentioned
 * roles, and `@everyone`/`@here`. None by default: mentions show, nobody is pinged.
 */
export const DISCORD_MENTION_TYPES = ['users', 'roles', 'everyone'] as const;
export type DiscordMentionType = (typeof DISCORD_MENTION_TYPES)[number];

/** Why a string isn't a Discord webhook URL, or null when it is one. */
export function discordWebhookUrlProblem(value: string): string | null {
  if (DISCORD_WEBHOOK_URL.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter the Discord webhook URL, such as https://discord.com/api/webhooks/<id>/<token>.';
  }
  if (url.protocol !== 'https:') return 'A Discord webhook URL starts with https://.';
  if (
    url.username ||
    url.password ||
    url.port ||
    !(DISCORD_WEBHOOK_HOSTS as readonly string[]).includes(url.hostname)
  ) {
    return 'A Discord webhook URL is on discord.com (or discordapp.com, ptb.discord.com, canary.discord.com).';
  }
  return 'A Discord webhook URL looks like https://discord.com/api/webhooks/<id>/<token>, with nothing after it.';
}

/** Whether a string is an http or https URL (an embed's link). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** `#RRGGBB` as Discord's colour integer. */
export function discordColor(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

/**
 * At most `max` UTF-16 units, ending in "…" when cut, never splitting a surrogate pair (so
 * never more than `max` characters however Discord counts them).
 */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A Discord step with its tokens filled in. */
export interface DiscordMessageInput {
  text: string;
  username?: string | undefined;
  embed?:
    | {
        title?: string | undefined;
        description?: string | undefined;
        url?: string | undefined;
        color?: string | undefined;
      }
    | undefined;
  mentions: readonly DiscordMentionType[];
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
}

export interface DiscordPayload {
  content?: string;
  username?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: DiscordMentionType[] };
}

/**
 * The JSON body for a filled-in step: texts trimmed and cut to Discord's limits, empty parts
 * left out, and `allowed_mentions` always set (nobody pinged unless the step allows it).
 * Throws an Error with a message for the run log when there is nothing to send or the embed's
 * link isn't an http(s) URL.
 */
export function discordPayload(input: DiscordMessageInput): DiscordPayload {
  const payload: DiscordPayload = {
    allowed_mentions: { parse: DISCORD_MENTION_TYPES.filter((t) => input.mentions.includes(t)) },
  };
  const content = truncateText(input.text.trim(), MAX_DISCORD_CONTENT);
  if (content) payload.content = content;
  const username = truncateText((input.username ?? '').trim(), MAX_DISCORD_USERNAME);
  if (username) payload.username = username;
  if (input.embed) {
    const embed: DiscordEmbed = {};
    const title = truncateText((input.embed.title ?? '').trim(), MAX_DISCORD_EMBED_TITLE);
    const description = truncateText(
      (input.embed.description ?? '').trim(),
      MAX_DISCORD_EMBED_DESCRIPTION
    );
    const url = (input.embed.url ?? '').trim();
    if (title) embed.title = title;
    if (description) embed.description = description;
    if (url) {
      if (url.length > MAX_DISCORD_EMBED_URL || !isHttpUrl(url)) {
        throw new Error("The embed's link isn't an http or https URL.");
      }
      embed.url = url;
    }
    // An embed shows only with a title or a description; a colour or link alone is left out.
    if (title || description) {
      if (input.embed.color) embed.color = discordColor(input.embed.color);
      payload.embeds = [embed];
    }
  }
  if (!payload.content && !payload.embeds) {
    throw new Error('The message is empty once its values are filled in.');
  }
  return payload;
}
