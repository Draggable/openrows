import { isSafeLinkUrl } from '@openrows/shared';
import type { Extensions } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { ListItem, TaskItem, TaskList } from '@tiptap/extension-list';
import { StarterKit } from '@tiptap/starter-kit';

/**
 * The editor's schema is the rich text Markdown subset: paragraphs, headings 1–3,
 * quotes, code blocks, flat bulleted, numbered and check lists, bold, italic, strikethrough,
 * inline code and links to http(s) or mailto. Whatever is pasted is parsed into this schema, so
 * tags, attributes, images and unsafe links have nowhere to go.
 */
export function richTextExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      blockquote: false,
      listItem: false,
      horizontalRule: false,
      underline: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        markdownLinks: true,
        defaultProtocol: 'https',
        isAllowedUri: (url) => isSafeLinkUrl(url),
        shouldAutoLink: (url) => isSafeLinkUrl(url) || isSafeLinkUrl(`https://${url}`),
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer', class: null },
      },
    }),
    // Lists are flat and quotes hold paragraphs, as the Markdown has them.
    Blockquote.extend({ content: 'paragraph+' }),
    ListItem.extend({ content: 'paragraph' }),
    TaskList,
    TaskItem.extend({ content: 'paragraph' }).configure({
      nested: false,
      a11y: { checkboxLabel: (_node, checked) => (checked ? 'Done' : 'Not done') },
    }),
  ];
}
