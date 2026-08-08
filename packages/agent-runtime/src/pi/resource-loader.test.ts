import { describe, expect, it } from "vite-plus/test";
import { createEmptyResourceLoader } from "./resource-loader";

describe("createEmptyResourceLoader", () => {
  const loader = createEmptyResourceLoader("system prompt");

  it("offers the composed system prompt and no discovered source", () => {
    expect(loader.getSystemPrompt()).toBe("system prompt");
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });

  it("discovers nothing", () => {
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
  });

  it("ignores extension-supplied resource paths and reloads to nothing", async () => {
    loader.extendResources({ skillPaths: [] });
    await expect(loader.reload()).resolves.toBeUndefined();
    expect(loader.getSkills().skills).toEqual([]);
  });
});
