import { Toaster as Sonner } from 'sonner';
import { useTheme } from '../../lib/theme';

/** sonner toasts on a neutral surface (DESIGN.md §7: no coloured left borders). */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: '!bg-surface !text-text !border !border-border !shadow-2 !rounded-md !text-body',
          description: '!text-text-2',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
