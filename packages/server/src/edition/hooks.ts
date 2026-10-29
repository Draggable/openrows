/**
 * A small typed hook registry: named hook points, each with its own handler signature
 * (EditionHooks in types.ts for the core's). Handlers run synchronously, in registration order;
 * a throwing handler stops the call (startup fails loudly rather than half-registering).
 */
type HookMap = Record<string, (...args: never[]) => void>;

/** At most this many handlers per hook point: a loop registering hooks is a bug. */
export const MAX_HANDLERS_PER_HOOK = 32;

export class HookRegistry<H extends HookMap> {
  readonly #handlers = new Map<keyof H, H[keyof H][]>();

  /** Adds a handler; returns a function that removes it again. */
  on<K extends keyof H>(name: K, handler: H[K]): () => void {
    const list = this.#handlers.get(name) ?? [];
    if (list.length >= MAX_HANDLERS_PER_HOOK) {
      throw new Error(`too many handlers for hook ${String(name)}`);
    }
    list.push(handler);
    this.#handlers.set(name, list);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** How many handlers the hook has. */
  count(name: keyof H): number {
    return this.#handlers.get(name)?.length ?? 0;
  }

  /** Runs every handler of the hook with `args`, in registration order. */
  run<K extends keyof H>(name: K, ...args: Parameters<H[K]>): void {
    for (const handler of [...(this.#handlers.get(name) ?? [])]) {
      (handler as (...a: Parameters<H[K]>) => void)(...args);
    }
  }
}
