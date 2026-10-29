import { useEffect, useState } from 'react';

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{
    keys: string[];
    description: string;
  }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['Arrow'], description: 'Move to adjacent cell' },
      { keys: ['Tab'], description: 'Move to next cell' },
      { keys: ['Shift', 'Tab'], description: 'Move to previous cell' },
      { keys: ['Cmd/Ctrl', 'Arrow'], description: 'Jump to edge' },
      { keys: ['Home'], description: 'Go to first column' },
      { keys: ['End'], description: 'Go to last column' },
      { keys: ['Cmd/Ctrl', 'Home'], description: 'Go to first cell' },
      { keys: ['Cmd/Ctrl', 'End'], description: 'Go to last cell' },
      { keys: ['Page Up/Down'], description: 'Move 10 rows' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: ['Enter'], description: 'Edit selected cell' },
      { keys: ['F2'], description: 'Edit selected cell' },
      { keys: ['Escape'], description: 'Exit editing mode' },
      { keys: ['Enter'], description: 'Save and move down (in edit mode)' },
      { keys: ['Tab'], description: 'Save and move right (in edit mode)' },
      { keys: ['Type any key'], description: 'Start editing with that character' },
    ],
  },
  {
    title: 'Clipboard',
    shortcuts: [
      { keys: ['Cmd/Ctrl', 'C'], description: 'Copy cell value' },
      { keys: ['Cmd/Ctrl', 'V'], description: 'Paste cell value' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { keys: ['Cmd/Ctrl', 'Z'], description: 'Undo' },
      { keys: ['Cmd/Ctrl', 'Shift', 'Z'], description: 'Redo' },
      { keys: ['Cmd/Ctrl', 'Y'], description: 'Redo (alternative)' },
      { keys: ['Cmd/Ctrl', 'Shift', 'Backspace'], description: 'Delete row' },
    ],
  },
];

interface KeyboardShortcutsHelpProps {
  onClose: () => void;
}

export function KeyboardShortcutsHelp({ onClose }: KeyboardShortcutsHelpProps) {
  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50 cursor-default"
        onClick={onClose}
        aria-label="Close keyboard shortcuts"
      />

      {/* Modal */}
      <div className="relative bg-background rounded-lg shadow-lg w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-accent"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <title>Close</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {SHORTCUT_GROUPS.map((group) => (
              <div key={group.title}>
                <h3 className="font-medium text-sm text-muted-foreground mb-2">{group.title}</h3>
                <div className="space-y-2">
                  {group.shortcuts.map((shortcut) => (
                    <div
                      key={`${shortcut.keys.join('+')} ${shortcut.description}`}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-muted-foreground">{shortcut.description}</span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, keyIndex) => (
                          <span key={key}>
                            {keyIndex > 0 && <span className="text-muted-foreground mx-1">+</span>}
                            <kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted border border-border rounded">
                              {key}
                            </kbd>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border text-center">
          <p className="text-xs text-muted-foreground">
            Press{' '}
            <kbd className="px-1 py-0.5 text-xs font-mono bg-muted border border-border rounded">
              ?
            </kbd>{' '}
            to toggle this help
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook to show keyboard shortcuts help with ? key
 */
export function useKeyboardShortcutsHelp() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
    toggle: () => setIsOpen((prev) => !prev),
  };
}
