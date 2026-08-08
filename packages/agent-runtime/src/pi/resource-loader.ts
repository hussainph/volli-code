/**
 * Zero-discovery resource loader.
 *
 * Pi's default loader walks the cwd and `~/.pi/agent` for extensions, skills,
 * prompt templates, themes, and context files. A Ticket Session must not inherit
 * any of that: everything it runs on is composed by the product. Supplying a
 * custom `ResourceLoader` is Pi's supported full bypass — with one installed,
 * cwd and agentDir stop driving discovery entirely.
 */

import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/** A loader that offers nothing but the composed system prompt. */
export function createEmptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
