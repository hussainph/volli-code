/** One module edge: the literal naming a module after an import-shaped keyword. */
export interface ModuleEdge {
  /** The decoded specifier; an interpolated template's raw text. */
  readonly specifier: string;
  /** The delimiter the source used. */
  readonly quote: '"' | "'" | "`";
  /** A template with a `${…}` substitution, so `specifier` is only its raw text. */
  readonly interpolated: boolean;
  /** Offset of the opening delimiter. */
  readonly start: number;
  /** Offset just past the closing delimiter. */
  readonly end: number;
}

export function moduleEdges(source: string): ModuleEdge[];
export function namesPackage(edge: ModuleEdge, packageName: string): boolean;
export function importsOfPackage(source: string, packageName: string): string[];
