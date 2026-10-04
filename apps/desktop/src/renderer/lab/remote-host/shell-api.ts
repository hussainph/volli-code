/**
 * The app shell's bridge for scratches that stage a flow over the real
 * window: the shared `appApi`, plus empty answers for the reads the shell
 * makes on the way up that would otherwise toast "Not stubbed" over the
 * very surface being judged.
 */
import type { ApiOverrides } from "../fake-api";
import { appApi } from "../seed";

export const shellApi: ApiOverrides = {
  ...appApi,
  browser: { list: () => Promise.resolve({ ok: true, tabs: [] }) },
  shells: { list: () => Promise.resolve({ ok: true, shells: [] }) },
  automations: {
    list: () => Promise.resolve({ ok: true, automations: [] }),
    enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: [] }),
    armings: () => Promise.resolve({ ok: true, armings: [] }),
    columnOrders: () => Promise.resolve({ ok: true, orders: [] }),
  },
};
