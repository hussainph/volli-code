import { z } from "zod";

/** Zod 4.6 accepts recursive input; a JSON wire cannot carry an object cycle. */
export const jsonWireSchema = z.json().refine(isAcyclic, "JSON values must not contain cycles");

function isAcyclic(value: unknown): boolean {
  const ancestors = new Set<object>();
  const checked = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return true;
    if (ancestors.has(node)) return false;
    // Shared references are valid JSON, and need only be checked once.
    if (checked.has(node)) return true;
    ancestors.add(node);
    for (const child of Object.values(node)) {
      if (!visit(child)) return false;
    }
    ancestors.delete(node);
    checked.add(node);
    return true;
  };
  return visit(value);
}
