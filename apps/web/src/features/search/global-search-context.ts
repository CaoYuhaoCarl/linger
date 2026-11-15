import { createContext, useContext } from "react";

/** Opens the global search dialog the Room shell owns. */
export const OpenGlobalSearchContext = createContext<() => void>(() => {});

/**
 * The shell's Search opener, so a page without its own dialog can offer the
 * same affordance the shortcut and the Room sidebar use.
 */
export function useOpenGlobalSearch() {
  return useContext(OpenGlobalSearchContext);
}
