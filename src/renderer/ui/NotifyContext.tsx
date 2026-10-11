import { createContext, useContext } from 'react';
import type { NotificationTone } from './AppOverlays';

export type Notify = (message: string, tone?: NotificationTone) => void;

const NotifyContext = createContext<Notify>(() => undefined);

/** The app's toast, for a component that reports an outcome without a prop chain to App. */
export const NotifyProvider = NotifyContext.Provider;

export function useNotify(): Notify {
  return useContext(NotifyContext);
}
