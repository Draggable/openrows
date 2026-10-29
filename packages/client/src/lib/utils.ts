import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** tailwind-merge that knows the Ledger type scale, so `text-body` isn't taken for a colour. */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['display', 'title', 'heading', 'body', 'small', 'caps'] } },
});

/** shadcn/ui's class helper: conditional classes, later Tailwind classes win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
