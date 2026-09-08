/**
 * Streamdown configuration for session chat markdown — the component overrides
 * and the rehype chain, together.
 *
 * Resolves images through the app's one image policy, fixes GFM task-list
 * chrome, styles <kbd>, and treats path-like inline code as file mentions.
 *
 * BOTH exports here are one decision, which is why they live in one module:
 * the `img` override cannot judge a source the sanitizer has already deleted,
 * so a surface that took the components without the plugins would draw the
 * wrong answer rather than no answer. Both chat Streamdowns — the answer
 * (`message.tsx`) and the reasoning body (`reasoning.tsx`) — take the pair.
 */
import * as React from "react";
import { defaultRehypePlugins, Streamdown, type Components } from "streamdown";
import { BLOB_URL_SCHEME } from "@volli/shared";

import { MarkdownImage } from "@renderer/components/attachments/markdown-image";
import { cn } from "@renderer/lib/utils";

/**
 * Streamdown's own rehype chain, with one protocol added to the sanitizer
 * (VC-273).
 *
 * Streamdown runs `rehype-sanitize` before our `img` component ever sees a
 * node, and its schema allows `http`/`https` on `src` and nothing else — it
 * extends `protocols.href` with `tel` and `streamdown` but never touches
 * `protocols.src`. So a `volli-blob:` image had its `src` deleted upstream, and
 * `rehype-harden` then reported the srcless node as `[Image blocked]`. Our
 * override was correct and simply never ran with a source to judge, which is
 * why the fix had to be here rather than in the component.
 *
 * DERIVED from `defaultRehypePlugins` rather than rebuilt: we take whatever
 * schema Streamdown ships and add to it, so a future release changing its
 * sanitization is inherited instead of silently overwritten by a stale copy.
 *
 * `data` rides along for the same reason it does in the Ticket pipeline, and is
 * narrowed the same way — the sanitizer admits the scheme, and
 * `resolveMarkdownImageSrc` in the `img` override still admits only
 * `data:image/*`.
 */
type RehypePlugins = NonNullable<React.ComponentProps<typeof Streamdown>["rehypePlugins"]>;

/** As much of `rehype-sanitize`'s schema as this app reads: URL protocols, and which tags survive. */
interface SanitizeSchemaLike {
  protocols?: Record<string, readonly string[] | undefined>;
  tagNames?: readonly string[];
}

/**
 * The schema Streamdown ships, read once. The file Preview's own policy
 * (`editor/markdown-preview-html.ts`) narrows ITS list against this one, so
 * there is a single place that knows the shape of somebody else's schema.
 */
const chatSanitizeSchema: SanitizeSchemaLike = (() => {
  const pluggable = defaultRehypePlugins["sanitize"];
  return Array.isArray(pluggable) ? (pluggable[1] as SanitizeSchemaLike) : {};
})();

/**
 * Every element the chat renderer's sanitizer keeps.
 *
 * Read leniently: if a future release changed the shape, this is EMPTY, and a
 * consumer intersecting with it admits nothing rather than everything — the
 * safe direction for a wrong answer about untrusted markup.
 */
export const CHAT_SANITIZED_TAG_NAMES: ReadonlySet<string> = new Set(chatSanitizeSchema.tagNames);

export const chatRehypePlugins: RehypePlugins = sanitizedRehypePlugins();

/**
 * The same chain, with `extras` run immediately AFTER sanitization.
 *
 * The seam exists for the read-only file Preview (VC-307), which needs one
 * rewriting pass of its own and needs it in exactly one place: after the
 * sanitizer, so what it mints cannot have come from the file, and before the
 * hardening step, which would otherwise replace a repository image path with
 * its own "blocked" stand-in. Keyed on the SANITIZE entry rather than on what
 * follows it, because "after sanitization" is the property that matters and the
 * only one this function can promise.
 *
 * A caller passing nothing gets the chat chain, which is how {@link chatRehypePlugins}
 * is defined — there is one derivation of the widened schema, not two.
 */
export function sanitizedRehypePlugins(
  extras: readonly RehypePlugins[number][] = [],
): RehypePlugins {
  const chain: RehypePlugins = [];
  for (const [name, pluggable] of Object.entries(defaultRehypePlugins)) {
    if (name !== "sanitize" || !Array.isArray(pluggable)) {
      chain.push(pluggable);
      continue;
    }
    const [plugin] = pluggable as [RehypePlugins[number], SanitizeSchemaLike];
    chain.push([
      plugin,
      {
        ...chatSanitizeSchema,
        protocols: {
          ...chatSanitizeSchema.protocols,
          src: [...(chatSanitizeSchema.protocols?.["src"] ?? []), BLOB_URL_SCHEME, "data"],
        },
      },
    ] as RehypePlugins[number]);
    chain.push(...extras);
  }
  return chain;
}

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

/**
 * File extensions that make a slash-less token a file name.
 *
 * A curated list rather than "any 1-12 letters after a dot", which is what the
 * previous heuristic used and why `` `3.14` `` and `` `e.g` `` rendered as
 * clickable file mentions in the middle of a sentence — the "weird syntax
 * highlighting" this ticket names. Anything with a `/` in it is still treated
 * as a path without consulting this list, because that is already a path.
 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "bash",
  "c",
  "cc",
  "cfg",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "d",
  "dockerfile",
  "env",
  "gif",
  "go",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "jose",
  "jpeg",
  "jpg",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsx",
  "kt",
  "less",
  "lock",
  "log",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "pl",
  "plist",
  "png",
  "prisma",
  "proto",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

/** A token that is only digits and dots (`3.14`, `1.2.3`) — a version or a number, never a file. */
const NUMERIC_RE = /^[0-9.]+$/;

/**
 * Heuristic for project/file path mentions in inline code.
 *
 * Deliberately conservative: a false positive puts a dotted underline and a
 * click target on a word that is not a file, in the middle of prose, and the
 * click does nothing. A false negative merely leaves an ordinary code span,
 * which is what the author wrote anyway.
 *
 * Known residual: a slash-less token whose extension is a real one is taken at
 * its word, so `` `Node.js` `` still reads as a file. Telling it from
 * `` `index.js` `` needs the workspace's file index, not a better regex — the
 * `@file` chips already resolve against that index, and this is the seam where
 * chat would do the same.
 */
export function looksLikeFilePath(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 240 || /\s/.test(text)) return false;
  if (text.includes("://")) return false;
  if (NUMERIC_RE.test(text)) return false;

  // A path is a path: anything with a separator, as long as it is not absolute
  // (an absolute path is not a project-relative mention this app can open).
  if (text.includes("/")) {
    return !text.startsWith("/") && /^[\w./@+-]+$/.test(text);
  }

  // No separator: only a known extension makes this a file name.
  const dot = text.lastIndexOf(".");
  if (dot <= 0 || dot === text.length - 1) return false;
  if (!/^[\w.@+-]+$/.test(text)) return false;
  return FILE_EXTENSIONS.has(text.slice(dot + 1).toLowerCase());
}

export const chatMarkdownComponents: Components = {
  em: ({ className, children, node: _node, ...props }) => (
    <em className={cn("italic", className)} {...props}>
      {children}
    </em>
  ),
  kbd: ({ className, children, node: _node, ...props }) => (
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
  /*
   * The previous allowlist here admitted exactly the sources that CANNOT load
   * on this origin (`/abs`, `./rel`, `file:`) and refused `volli-blob:`, the
   * one that can — so an agent writing the attachment path it was given in the
   * brief got a broken-image glyph (VC-273). The decision now lives in
   * `@volli/shared` and is shared with the Ticket-body pipeline, so the same
   * markdown renders the same way wherever it is written.
   */
  img: ({ className, src, alt }) => (
    <MarkdownImage
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      className={className}
    />
  ),
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
  li: ({ className, children, node: _node, ...props }) => {
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
  input: ({ className, type, node: _node, ...props }) => {
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
  inlineCode: ({ className, children, node: _node, ...props }) => {
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
  section: ({ className, children, node: _node, ...props }) => {
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
