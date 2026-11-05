import { createContext, useContext } from "react";

/** The shell owns placement; each workspace still owns its resident inspector. */
export const InspectorHostContext = createContext<HTMLElement | null | undefined>(undefined);
export function useInspectorHost() {
  return useContext(InspectorHostContext);
}
