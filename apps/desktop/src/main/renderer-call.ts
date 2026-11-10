/** Local transport identity for device-local effects; never caller-supplied input. */
import { AsyncLocalStorage } from "node:async_hooks";

const rendererCalls = new AsyncLocalStorage<number>();
export function withRendererCall<T>(contentsId: number, run: () => T): T {
  return rendererCalls.run(contentsId, run);
}
export function currentRendererId(): number | undefined {
  return rendererCalls.getStore();
}
