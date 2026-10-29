import { createContext, useContext } from 'react';

/** App-wide UI actions any screen can trigger (the command palette, the create-base dialog). */
export interface AppActions {
  openPalette: () => void;
  openCreateBase: (workspaceId?: string) => void;
}

export const AppActionsContext = createContext<AppActions>({
  openPalette: () => {},
  openCreateBase: () => {},
});

export const useAppActions = () => useContext(AppActionsContext);
