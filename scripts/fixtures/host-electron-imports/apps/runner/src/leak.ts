// Fixture: a runner module that reaches Electron must fail the guard.
import { app } from "electron";

export const name = app.getName();
