import type {
  BrowserPictureInput,
  BrowserPictureResult,
  BrowserTabCaptureResult,
  BrowserTabIdInput,
  BrowserTabListInput,
  BrowserTabListResult,
  BrowserTabNavigateInput,
  BrowserTabOpenInput,
  BrowserTabResult,
  BrowserTabSetBoundsInput,
  BrowserTabSetPresentationInput,
  BrowserTabStateEvent,
  Result,
} from "../../../../ipc/contract";

/**
 * Renderer view of the frozen Browser preload bridge.
 *
 * Kept structural so the Browser workspace can inject it in component tests
 * without mocking Electron. The production value is `window.api.browser`.
 */
export interface BrowserApi {
  open(input: BrowserTabOpenInput): Promise<BrowserTabResult>;
  close(input: BrowserTabIdInput): Promise<Result>;
  list(input: BrowserTabListInput): Promise<BrowserTabListResult>;
  navigate(input: BrowserTabNavigateInput): Promise<BrowserTabResult>;
  back(input: BrowserTabIdInput): Promise<BrowserTabResult>;
  forward(input: BrowserTabIdInput): Promise<BrowserTabResult>;
  reload(input: BrowserTabIdInput): Promise<BrowserTabResult>;
  setBounds(input: BrowserTabSetBoundsInput): Promise<Result>;
  capture(input: BrowserTabIdInput): Promise<BrowserTabCaptureResult>;
  show(input: BrowserTabIdInput): Promise<Result>;
  hide(input: BrowserTabIdInput): Promise<Result>;
  toggleDevTools(input: BrowserTabIdInput): Promise<Result>;
  /** Where a Session's tab is drawn (VC-238); refused for a person's own tab. */
  setPresentation(input: BrowserTabSetPresentationInput): Promise<BrowserTabResult>;
  /** One picture the transcript names, as a data URL — or null once the host let it go. */
  picture(input: BrowserPictureInput): Promise<BrowserPictureResult>;
  /** The person's hold controls (VC-239): take the tab, give it back, ask the holder to leave. */
  takeOver(input: BrowserTabIdInput): Promise<BrowserTabResult>;
  handBack(input: BrowserTabIdInput): Promise<BrowserTabResult>;
  askToLeave(input: BrowserTabIdInput): Promise<Result>;
  onTabState(callback: (event: BrowserTabStateEvent) => void): () => void;
}
