import { emptyOptions, textLike } from '../text-like.js';

const PHONE_RE = /^\+?[\d\s().\-/]*\d[\d\s().\-/]*(?:\s*(?:x|ext\.?)\s*\d+)?$/i;

/** A phone number as typed (digits, spaces, `+ - ( ) . /`, an optional extension), trimmed. */
export const phone = {
  ...textLike({
    name: 'phone',
    label: 'Phone number',
    category: 'contact',
    optionsSchema: emptyOptions,
    editor: { kind: 'phone', align: 'left', width: 160 },
    maxLength: 50,
    normalize: (text) => {
      const t = text.trim().replace(/\s+/g, ' ');
      return PHONE_RE.test(t) ? t : null;
    },
  }),
  apiType: () => 'phoneNumber',
};
