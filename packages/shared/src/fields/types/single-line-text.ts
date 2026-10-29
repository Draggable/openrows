import { emptyOptions, MAX_TEXT_LENGTH, textLike } from '../text-like.js';

/** One line of text; line breaks become spaces. */
export const singleLineText = textLike({
  name: 'singleLineText',
  label: 'Single line text',
  category: 'basic',
  optionsSchema: emptyOptions,
  editor: { kind: 'text', align: 'left', width: 200 },
  maxLength: MAX_TEXT_LENGTH,
  conversionInput: 'display',
  normalize: (text) => text.replace(/\r\n|[\r\n]/g, ' '),
});
