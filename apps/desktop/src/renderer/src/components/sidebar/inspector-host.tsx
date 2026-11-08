import { createContext, useContext } from "react";

/** The shell owns placement; each workspace still owns its resident inspector. */
export const InspectorHostContext = createContext<HTMLElement | null | undefined>(undefined);
export function useInspectorHost() {
  return useContext(InspectorHostContext);
}

/** Resident pages stay mounted while hidden; expensive readers follow visibility. */
export const InspectorVisibleContext = createContext(true);
export function useInspectorVisible() {
  return useContext(InspectorVisibleContext);
}
