import { describe, expect, it } from "vite-plus/test";
import {
  classifyAppStateKey,
  CHAT_DRAFTS_APP_STATE_KEY,
  NEW_TICKET_DRAFT_APP_STATE_KEY,
} from "@volli/shared";
import { UI_APP_STATE_KEY } from "../stores/ui";
import { PROJECT_UI_APP_STATE_KEY } from "../stores/project-ui";
import { PROJECTS_UI_APP_STATE_KEY } from "../stores/projects";
import { DRAFT_KEY } from "../components/automations/editor-draft";

describe("renderer persistence constants", () => {
  it.each([
    UI_APP_STATE_KEY,
    PROJECT_UI_APP_STATE_KEY,
    PROJECTS_UI_APP_STATE_KEY,
    CHAT_DRAFTS_APP_STATE_KEY,
    NEW_TICKET_DRAFT_APP_STATE_KEY,
    DRAFT_KEY,
  ])("%s is client-local", (key) => {
    expect(classifyAppStateKey(key)?.placement).toBe("client-local");
  });
});
