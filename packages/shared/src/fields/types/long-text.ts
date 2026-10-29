import { z } from 'zod';
import { sanitizeMarkdown } from '../markdown.js';
import { MAX_TEXT_LENGTH, textLike } from '../text-like.js';

/**
 * Multi-line text. Line endings become `\n`. With `richText` the text is Markdown, as in
 * Airtable, sanitized with an allow-list on every write (markdown.ts): no HTML, links only
 * to http(s) and mailto. Turning `richText` on re-sanitizes every cell (an option change
 * re-coerces), and plain text is valid Markdown, so the switch keeps the text.
 */
export const longText = {
  ...textLike({
    name: 'longText',
    label: 'Long text',
    category: 'basic',
    optionsSchema: z.object({ richText: z.boolean().default(false) }).strict(),
    editor: { kind: 'longText', align: 'left', width: 200 },
    maxLength: MAX_TEXT_LENGTH,
    conversionInput: 'display',
    normalize: (text, o) => {
      const t = text.replace(/\r\n?/g, '\n');
      return o.richText ? sanitizeMarkdown(t) : t;
    },
  }),
  apiType: (o: { richText: boolean }) => (o.richText ? 'richText' : 'multilineText'),
};
