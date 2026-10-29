import { useEffect, useRef, useState } from 'react';

/** An input that replaces a name in place: Enter or blur saves, Escape cancels. */
export function InlineRename({
  value,
  label,
  onSubmit,
  onDone,
}: {
  value: string;
  label: string;
  onSubmit: (name: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (save && name && name !== value) onSubmit(name);
    onDone();
  };

  return (
    <input
      ref={ref}
      aria-label={label}
      value={draft}
      maxLength={255}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      className="mx-2 h-8 w-[calc(100%-1rem)] rounded-sm border border-primary bg-surface px-2.5 text-body text-text"
    />
  );
}
