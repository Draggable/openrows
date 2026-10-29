interface DragHandleProps {
  className?: string;
}

/**
 * A drag handle icon for drag and drop reordering
 */
export function DragHandle({ className = '' }: DragHandleProps) {
  return (
    <button
      type="button"
      className={`cursor-grab active:cursor-grabbing focus:outline-none ${className}`}
      aria-label="Drag to reorder"
      tabIndex={-1}
    >
      <svg
        className="w-4 h-4 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <title>Drag handle</title>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
      </svg>
    </button>
  );
}
