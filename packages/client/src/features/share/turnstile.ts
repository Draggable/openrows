import { useEffect, useRef, useState } from 'react';

/**
 * Cloudflare Turnstile in the public pages: public forms and, share-link password
 * prompts, when the server has a site key. The script is loaded once, only when a widget shows.
 */
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    }
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const ready = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = ready();
      if (api) resolve(api);
      else reject(new Error('Turnstile did not load'));
    };
    script.onerror = () => {
      turnstileLoading = null;
      reject(new Error('Turnstile did not load'));
    };
    document.head.append(script);
  });
  return turnstileLoading;
}

/** The Turnstile widget when there is a site key: its token and a reset. */
export function useTurnstile(siteKey: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !ref.current) return;
        const id = api.render(ref.current, {
          sitekey: siteKey,
          callback: setToken,
          'expired-callback': () => setToken(null),
          'error-callback': () => setToken(null),
        });
        widget.current = { api, id };
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey]);
  return {
    ref,
    token,
    reset: () => {
      setToken(null);
      if (widget.current) widget.current.api.reset(widget.current.id);
    },
  };
}
