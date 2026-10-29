import { emptyOptions, textLike } from '../text-like.js';

const URL_RE = /^https?:\/\/[^\s/?#.][^\s/?#]*(?:[/?#]\S*)?$/i;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * An http(s) URL, trimmed. A bare domain (`openrows.io/docs`) gets `https://`. Other schemes
 * (`javascript:`, `data:`, ...) are empty, so a cell link is always safe to render.
 */
export const url = textLike({
  name: 'url',
  label: 'URL',
  category: 'contact',
  optionsSchema: emptyOptions,
  editor: { kind: 'url', align: 'left', width: 200 },
  maxLength: 2048,
  normalize: (text) => {
    const t = text.trim();
    if (URL_RE.test(t)) return t;
    if (DOMAIN_RE.test(t)) return `https://${t}`;
    return null;
  },
});
