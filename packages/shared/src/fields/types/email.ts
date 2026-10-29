import { emptyOptions, textLike } from '../text-like.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]+$/;

/** An email address, trimmed. Anything that doesn't look like one is empty. */
export const email = textLike({
  name: 'email',
  label: 'Email',
  category: 'contact',
  optionsSchema: emptyOptions,
  editor: { kind: 'email', align: 'left', width: 200 },
  maxLength: 254,
  normalize: (text) => {
    const t = text.trim();
    return EMAIL_RE.test(t) ? t : null;
  },
});
