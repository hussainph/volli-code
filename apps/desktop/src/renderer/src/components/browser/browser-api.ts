import type {
  BrowserTabIdInput,
  BrowserTabListInput,
  BrowserTabListResult,
  BrowserTabNavigateInput,
  BrowserTabOpenInput,
  BrowserTabResult,
  BrowserTabSetBoundsInput,
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
  show(input: BrowserTabIdInput): Promise<Result>;
  hide(input: BrowserTabIdInput): Promise<Result>;
  toggleDevTools(input: BrowserTabIdInput): Promise<Result>;
  onTabState(callback: (event: BrowserTabStateEvent) => void): () => void;
}
