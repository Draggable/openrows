import { BracesIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import { insertToken, type TokenOption } from './model';

export const textareaClass =
  'min-h-20 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-body text-text placeholder:text-text-3 hover:border-border-strong';

/**
 * A text input (or textarea) with a token picker: the button lists what the trigger and
 * the steps before this one give, by friendly label, and puts its `{{…}}` token at the caret.
 */
export function TokenInput({
  id,
  label,
  value,
  onChange,
  tokens,
  multiline = false,
  placeholder,
  invalid = false,
  describedBy,
}: {
  id: string;
  /** The field's name, for the picker button's label. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  tokens: readonly TokenOption[];
  multiline?: boolean;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number | null; end: number | null }>({
    start: null,
    end: null,
  });
  const [open, setOpen] = useState(false);
  const remember = () => {
    const el = ref.current;
    if (el) selection.current = { start: el.selectionStart, end: el.selectionEnd };
  };
  const pick = (token: string) => {
    const next = insertToken(value, selection.current.start, selection.current.end, token);
    onChange(next.value);
    setOpen(false);
    // Back to the field, the caret after the token.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      selection.current = { start: next.caret, end: next.caret };
    });
  };
  const groups = [...new Set(tokens.map((t) => t.group))];
  const common = {
    id,
    value,
    placeholder,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    onSelect: remember,
    onBlur: remember,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
  };
  return (
    <div className="flex items-start gap-1">
      {multiline ? (
        <textarea
          {...common}
          ref={ref}
          rows={4}
          className={cn(textareaClass, invalid && 'border-danger')}
        />
      ) : (
        <Input {...common} ref={ref} className={cn(invalid && 'border-danger')} />
      )}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) remember();
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="mt-0.5"
            aria-label={`Insert a value into ${label}`}
            disabled={tokens.length === 0}
          >
            <BracesIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[340px] p-0" aria-label="Insert a value">
          <Command>
            <CommandInput placeholder="Search values…" aria-label="Search values" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group} heading={group}>
                  {tokens
                    .filter((t) => t.group === group)
                    .map((t) => (
                      <CommandItem
                        key={t.token}
                        value={`${group} ${t.label} ${t.token}`}
                        onSelect={() => pick(t.token)}
                      >
                        <span className="min-w-0 flex-1 truncate">{t.label}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
