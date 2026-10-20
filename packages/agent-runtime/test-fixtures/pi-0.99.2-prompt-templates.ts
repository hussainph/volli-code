/** Frozen Pi 0.99.2 grammar oracle, MIT; see vendor/pi-harness/README.md. Test-only. */
interface PromptTemplate {
  name: string;
  description?: string;
  content: string;
}
/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i]!;
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments. */
export function substituteArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr: string, lengthStr?: string) => {
      let start = parseInt(startStr, 10) - 1;
      if (start < 0) start = 0;
      if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
      return args.slice(start).join(" ");
    },
  );
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

/** Format a prompt template invocation with positional arguments. */
export function formatPromptTemplateInvocation(
  template: PromptTemplate,
  args: string[] = [],
): string {
  return substituteArgs(template.content, args);
}
