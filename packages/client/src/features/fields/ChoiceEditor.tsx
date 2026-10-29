import { CHOICE_COLORS, type Choice } from '@openrows/shared';
import { GripVertical, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import { addChoice, moveChoice, removeChoice, updateChoice } from './model';

const DRAG_TYPE = 'application/x-openrows-choice';

const colorName = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

/**
 * The select-choice editor: add, rename, recolour, reorder (drag the grip, or Alt+↑/↓ in a
 * name) and remove choices. Enter in a name adds the next choice. Ids stay stable, so renaming
 * or recolouring a choice keeps every cell that uses it.
 */
export function ChoiceEditor({
  choices,
  onChange,
}: {
  choices: Choice[];
  onChange: (choices: Choice[]) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  useEffect(() => {
    if (!focusId) return;
    list.current?.querySelector<HTMLInputElement>(`[data-choice="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId]);

  const add = () => {
    const next = addChoice(choices, '');
    onChange(next);
    setFocusId(next.at(-1)?.id ?? null);
  };
  const move = (from: number, to: number) => {
    const id = choices[from]?.id;
    onChange(moveChoice(choices, from, to));
    if (id) setFocusId(id);
  };

  return (
    <div className="grid gap-1.5">
      <span className="text-small text-text-2">Choices</span>
      {choices.length > 0 && (
        <ul ref={list} aria-label="Choices" className="grid gap-1">
          {choices.map((choice, i) => (
            <li
              key={choice.id}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setDragOver(i);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                const from = Number(e.dataTransfer.getData(DRAG_TYPE));
                setDragOver(null);
                if (Number.isInteger(from)) move(from, i);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-sm',
                dragOver === i && 'bg-hover outline-1 outline-border-strong'
              )}
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label="Drag to reorder (or Alt+arrow keys in the name)"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, String(i));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                className="flex cursor-grab text-text-3 active:cursor-grabbing"
              >
                <GripVertical className="size-4" aria-hidden />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`Color of ${choice.name || 'new choice'}: ${choice.color}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
                >
                  <span
                    className="size-3.5 rounded-full"
                    style={{ background: `var(--chip-${choice.color})` }}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {CHOICE_COLORS.map((color) => (
                    <DropdownMenuItem
                      key={color}
                      onSelect={() => onChange(updateChoice(choices, choice.id, { color }))}
                      className={cn(color === choice.color && 'bg-selected')}
                    >
                      <span
                        className="size-3 rounded-full"
                        style={{ background: `var(--chip-${color})` }}
                        aria-hidden
                      />
                      {colorName(color)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                data-choice={choice.id}
                aria-label={`Choice ${i + 1}`}
                value={choice.name}
                maxLength={255}
                placeholder="Choice name"
                onChange={(e) =>
                  onChange(updateChoice(choices, choice.id, { name: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                  } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    add();
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 text-body text-text placeholder:text-text-3 hover:border-border-strong"
              />
              <button
                type="button"
                aria-label={`Remove ${choice.name || 'choice'}`}
                onClick={() => onChange(removeChoice(choices, choice.id))}
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-2 hover:bg-hover hover:text-text"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={add}>
        <Plus aria-hidden />
        Add choice
      </Button>
    </div>
  );
}
