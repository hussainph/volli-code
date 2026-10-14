/**
 * Frozen main baseline for the desktop Session tool surface (VC-622 a2).
 *
 * Provenance: every value below was produced by main's own
 * `sessionToolSurface.resolve` closure as it shipped at bdc0e925b (the last
 * main commit before VC-622 lifted it), extracted verbatim by the a1 verifier
 * (reference-only scratch: .scratch/vc622a1-verify/verify-tests/
 * zz-main-resolve.verify.ts, also pasted as .scratch/vc622a1-verify/
 * main-resolve.txt) and run against this worktree's dependencies
 * (`@volli/shared`'s resolver and `PI_TOOLS`) over the verifier's exact
 * 336-combination matrix, in its enumeration order: web unconfigured/
 * configured x Role x durable grants x parent bound present/absent x MCP
 * tools none/one x Code Mode birth undefined/unoffered/offered x classify
 * off/on. Nothing was derived from `resolveHostToolSurface` or from the
 * shared resolver at test time; the covering test reads this file and
 * nothing else.
 *
 * Encoding:
 * - `surfaces` — one distinct resolved surface per entry, tools comma-joined
 *   in the frozen canonical order (no tool name contains a comma, checked
 *   at generation; no verified surface is empty — `read` survives every
 *   verified parent bound).
 * - `errors` — the exact messages main refused the inputs with.
 * - `table` — one entry per verified combination in enumeration order;
 *   `n >= 0` names `surfaces[n]`, `n < 0` names `errors[-n - 1]`.
 */
export interface MainSurfaceBaseline {
  readonly surfaces: readonly string[];
  readonly errors: readonly string[];
  readonly table: readonly number[];
}

export const MAIN_SURFACE_BASELINE: MainSurfaceBaseline = {
  surfaces: [
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,codemode,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,codemode,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,browser_tabs,todo_write,shell_start,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,browser_tabs,todo_write,shell_start,codemode,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,request_secret,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,request_secret,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,codemode,request_secret,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,codemode,request_secret,session.delegate,watch",
    "read,browser_tabs,todo_write,shell_start,session.delegate,watch",
    "read,browser_tabs,todo_write,shell_start,codemode,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,request_secret,session.start,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,request_secret,session.start,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,codemode,request_secret,session.start,session.delegate,watch",
    "read,edit,write,execute,ask_user,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,codemode,request_secret,session.start,session.delegate,watch",
    "read,browser_tabs,todo_write,shell_start,session.start,session.delegate,watch",
    "read,browser_tabs,todo_write,shell_start,codemode,session.start,session.delegate,watch",
    "read,edit,write,execute,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find",
    "read,edit,write,execute,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find,classify",
    "read,edit,write,execute,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find,codemode",
    "read,edit,write,execute,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find,classify,codemode",
    "read,browser_tabs,shell_start",
    "read,browser_tabs,shell_start,codemode",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,codemode,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,codemode,request_secret,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,web_fetch,browser_tabs,todo_write,shell_start,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,web_fetch,browser_tabs,todo_write,shell_start,codemode,session.start,automation.run,session.stop,session.send,session.delegate,mcp.list,mcp.preview,mcp.install,mcp.refresh,mcp.enable,mcp.disable,mcp.tools,mcp.remove,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,request_secret,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,request_secret,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,codemode,request_secret,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,codemode,request_secret,session.delegate,watch",
    "read,web_fetch,browser_tabs,todo_write,shell_start,session.delegate,watch",
    "read,web_fetch,browser_tabs,todo_write,shell_start,codemode,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,request_secret,session.start,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,request_secret,session.start,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,codemode,request_secret,session.start,session.delegate,watch",
    "read,edit,write,execute,ask_user,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,todo_write,shell_start,shell_output,shell_kill,browser_find,classify,codemode,request_secret,session.start,session.delegate,watch",
    "read,web_fetch,browser_tabs,todo_write,shell_start,session.start,session.delegate,watch",
    "read,web_fetch,browser_tabs,todo_write,shell_start,codemode,session.start,session.delegate,watch",
    "read,edit,write,execute,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find",
    "read,edit,write,execute,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find,classify",
    "read,edit,write,execute,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find,codemode",
    "read,edit,write,execute,web_fetch,web_search,browser_tabs,browser_navigate,browser_snapshot,browser_act,browser_screenshot,browser_console,browser_acquire,browser_release,shell_start,shell_output,shell_kill,browser_find,classify,codemode",
    "read,web_fetch,browser_tabs,shell_start",
    "read,web_fetch,browser_tabs,shell_start,codemode",
  ],
  errors: [
    "Cannot read properties of undefined (reading 'length')",
    "ticket.create is not a verb this build can offer as a tool, so it cannot be granted",
  ],
  table: [
    0, 1, 0, 1, 2, 3, -1, -1, -1, -1, -1, -1, 4, 4, 4, 4, 5, 5, -1, -1, -1, -1, -1, -1, 0, 1, 0, 1,
    2, 3, -1, -1, -1, -1, -1, -1, 4, 4, 4, 4, 5, 5, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, 6, 7, 6, 7, 8, 9, -1,
    -1, -1, -1, -1, -1, 10, 10, 10, 10, 11, 11, -1, -1, -1, -1, -1, -1, 12, 13, 12, 13, 14, 15, -1,
    -1, -1, -1, -1, -1, 16, 16, 16, 16, 17, 17, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, 18, 19, 18, 19, 20, 21, -1,
    -1, -1, -1, -1, -1, 22, 22, 22, 22, 23, 23, -1, -1, -1, -1, -1, -1, 24, 25, 24, 25, 26, 27, -1,
    -1, -1, -1, -1, -1, 28, 28, 28, 28, 29, 29, -1, -1, -1, -1, -1, -1, 24, 25, 24, 25, 26, 27, -1,
    -1, -1, -1, -1, -1, 28, 28, 28, 28, 29, 29, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, 30, 31, 30, 31, 32, 33, -1,
    -1, -1, -1, -1, -1, 34, 34, 34, 34, 35, 35, -1, -1, -1, -1, -1, -1, 36, 37, 36, 37, 38, 39, -1,
    -1, -1, -1, -1, -1, 40, 40, 40, 40, 41, 41, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -2, -2, -2,
    -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, 42, 43, 42, 43, 44, 45, -1,
    -1, -1, -1, -1, -1, 46, 46, 46, 46, 47, 47, -1, -1, -1, -1, -1, -1,
  ],
};
