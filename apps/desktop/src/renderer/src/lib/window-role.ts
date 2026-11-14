/** Which window this renderer is. Dependency-free, so stores may ask it. */
export const isSettingsWindow = (): boolean =>
  typeof window !== "undefined" && window.location?.hash === "#settings";
