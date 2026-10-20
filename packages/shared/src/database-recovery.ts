export interface DatabaseSafetyCopy {
  name: string;
  modifiedAt: number;
  /**
   * `newer`: the copy checks clean but comes from a newer Volli this build
   * cannot open (VC-602), so restore passes over it.
   */
  integrity: "clean" | "damaged" | "unavailable" | "newer";
}
