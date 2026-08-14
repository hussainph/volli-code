/**
 * Streamdown component overrides for session chat markdown.
 * Keeps remote images local/data-only, fixes GFM task-list chrome, styles
 * <kbd>, and treats path-like inline code as file mentions.
 */
import * as React from "react";
import type { Components } from "streamdown";

import { cn } from "@renderer/lib/utils";

const FileMentionContext = React.createContext<((path: string) => void) | null>(null);

export function FileMentionProvider({
  onOpenFile,
  children,
}: {
  onOpenFile?: (path: string) => void;
  children: React.ReactNode;
}) {
  return (
    <FileMentionContext.Provider value={onOpenFile ?? null}>{children}</FileMentionContext.Provider>
  );
}

function isAllowedImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  if (src.startsWith("data:")) return true;
  if (src.startsWith("blob:")) return true;
  // Relative / app-local assets only — no remote https.
  if (src.startsWith("/") || src.startsWith("./") || src.startsWith("../")) return true;
  if (src.startsWith("volli-app:") || src.startsWith("file:")) return true;
  return false;
}

/** Heuristic for project/file path mentions in inline code. */
export function looksLikeFilePath(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 240 || /\s/.test(text)) return false;
  if (text.startsWith("http://") || text.startsWith("https://")) return false;
  if (text.includes("://")) return false;
  // extension, nested path, or common project roots
  if (/^[A-Za-z0-9_./@+-]+\.[A-Za-z0-9]{1,12}$/.test(text)) return true;
  if (
    text.startsWith("src/") ||
    text.startsWith("apps/") ||
    text.startsWith("packages/") ||
    text.startsWith("./") ||
    text.startsWith("../")
  ) {
    return true;
  }
  return text.includes("/") && !text.startsWith("/") && /^[\w./@+-]+$/.test(text);
}

export const chatMarkdownComponents: Components = {
  em: ({ className, children, ...props }) => (
    <em className={cn("italic", className)} {...props}>
      {children}
    </em>
  ),
  kbd: ({ className, children, ...props }) => (
    <kbd
      className={cn(
        "mx-1 inline-flex min-h-5 items-center rounded-sm border border-border bg-muted px-1 font-mono text-[0.8em] text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  ),
  img: ({ className, src, alt, ...props }) => {
    if (!isAllowedImageSrc(typeof src === "string" ? src : undefined)) {
      return (
        <span className="inline-flex items-center rounded-sm border border-border bg-muted px-2 py-1 text-ui text-muted-foreground">
          Image blocked (local/data only)
        </span>
      );
    }
    return (
      <img
        className={cn("my-2 max-h-80 max-w-full rounded-md border border-border", className)}
        src={src}
        alt={alt ?? ""}
        {...props}
      />
    );
  },
  ul: ({ className, children, node, ...props }) => {
    const fromNode =
      Array.isArray(node?.properties?.className) &&
      node.properties.className.some((entry) => String(entry).includes("contains-task-list"));
    const fromClass = typeof className === "string" && className.includes("contains-task-list");
    const isTaskList = fromNode || fromClass;
    return (
      <ul
        className={cn(
          isTaskList ? "list-none space-y-1 pl-1" : "list-disc list-outside space-y-1 pl-4",
          className,
        )}
        {...props}
      >
        {children}
      </ul>
    );
  },
  li: ({ className, children, ...props }) => {
    const isTask = typeof className === "string" && className.includes("task-list-item");
    return (
      <li
        className={cn(isTask && "flex list-none items-start gap-2 [&>input]:mt-1", className)}
        {...props}
      >
        {children}
      </li>
    );
  },
  input: ({ className, type, ...props }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          disabled
          className={cn("mt-1 size-3.5 accent-[var(--primary)]", className)}
          {...props}
        />
      );
    }
    return <input type={type} className={className} {...props} />;
  },
  inlineCode: ({ className, children, ...props }) => {
    const text = React.Children.toArray(children)
      .map((child) => (typeof child === "string" ? child : ""))
      .join("");
    if (!looksLikeFilePath(text)) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return <FileMentionCode className={className} path={text.trim()} {...props} />;
  },
  section: ({ className, children, ...props }) => {
    const isFootnotes =
      typeof className === "string" &&
      (className.includes("footnotes") || className.includes("data-footnotes"));
    return (
      <section
        className={cn(
          isFootnotes &&
            "mt-6 border-t border-border pt-4 text-ui text-muted-foreground [&>ol]:list-decimal [&>ol]:pl-4",
          className,
        )}
        {...props}
      >
        {children}
      </section>
    );
  },
};

/*
 * A file mention is a link, not a chip. A border would claim it is an object you
 * can act on in place; the dotted underline says "this leads somewhere" and the
 * accent on hover confirms it is live. Inert code spans keep their own
 * treatment, so the two can no longer be confused for each other.
 */
const FILE_MENTION_CLASS =
  "font-mono text-[0.9em] text-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-[3px]";

function FileMentionCode({
  path,
  className,
  ...props
}: React.ComponentProps<"code"> & { path: string }) {
  const onOpenFile = React.useContext(FileMentionContext);
  if (!onOpenFile) {
    return (
      <code className={cn(FILE_MENTION_CLASS, className)} {...props}>
        {path}
      </code>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        FILE_MENTION_CLASS,
        "cursor-pointer rounded-sm transition-colors hover:text-primary hover:decoration-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onClick={() => onOpenFile(path)}
    >
      {path}
    </button>
  );
}
