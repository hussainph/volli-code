/**
 * The whole window: the app's real `AppShell`, seeded with the demo project.
 *
 * Chrome band, project rail, two-tier sidebar, Active Sessions, the framed
 * content card floating on the theme canvas, grain, and the board inside it —
 * all the actual components, laid out by the actual shell. It is the answer to
 * "what does this change do to the window", which a component scratch
 * structurally cannot show you: proportion between panes, how the card's margin
 * reads against the rail, whether the sidebar's tiers crowd the nav.
 *
 * Imported rather than recomposed. Standing the shell's layout up by hand here
 * would produce something that agrees with the app until the day it doesn't,
 * and a lab that quietly disagrees with the app is worse than no lab — so the
 * one thing this file must never do is describe a layout.
 *
 * The honest limit: `MainContent` always mounts `SessionsLayer`, which owns
 * every terminal. With no sessions seeded it mounts empty and boots no engine,
 * so the shell is real — but a terminal is the one surface in here that cannot
 * be. Judge chrome, layout, and navigation here; judge terminals in the app.
 */
import { AppShell } from "@renderer/components/app-shell";

import { appApi, seedApp } from "../seed";

export const title = "App shell";
export const note = "The whole window — real shell, real panes, fixture data";
export const viewport = "window" as const;

export const seed = seedApp;
export const api = appApi;

export default AppShell;
