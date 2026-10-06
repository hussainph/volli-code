/**
 * `@volli/host-core/browser`: the agent browser's engine-agnostic half: backend interface, CDP controller, stores.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export { browserAgentPort } from "../browser/agent-port";
export {
  BROWSER_DEFAULT_BOUNDS,
  BROWSER_MAX_TABS_PER_PROJECT,
  BROWSER_MAX_TABS_PER_SESSION,
  BROWSER_URL_MAX_CHARS,
  type BrowserBackend,
  type BrowserHoldEvent,
  type BrowserLoadWaitMode,
  browserSessionPartition,
  BrowserSessionTabLimitError,
  type BrowserTabCreateOptions,
  BrowserTabLimitError,
  isAllowedBrowserUrl,
} from "../browser/backend";
export type { CdpTransport, TabCursorDriver, TabCursorGesture } from "../browser/cdp-controller";
export {
  ChromiumBrowserBackend,
  type ChromiumBrowserBackendOptions,
  type ChromiumBrowserBackendPorts,
} from "../browser/chromium-backend";
export { ChromiumLaunchError } from "../browser/chromium-launch";
export { browserPictureDisk, browserPicturesRoot } from "../browser/picture-disk";
export { type BrowserPictureRecord, BrowserPictureStore } from "../browser/picture-store";
export {
  BROWSER_CONSOLE_MAX_CHARS,
  BROWSER_TITLE_MAX_CHARS,
  type BrowserTabChrome,
  type BrowserTabRecord,
  BrowserTabRegistry,
  type BrowserTabRegistryPorts,
} from "../browser/tab-registry";
export { browserTraceDisk, browserTracesRoot } from "../browser/trace-disk";
export { type BrowserTraceStepInput, BrowserTraceStore } from "../browser/trace-store";
