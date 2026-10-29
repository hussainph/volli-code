/** Automations alone have a cloud source; local machine tools remain gated. */
import type { ComponentProps } from "react";
import { LocalOnly } from "@renderer/components/hosts/local-only";
import { automationSourceIsCloud } from "@renderer/stores/automation-source";
export function AutomationsOnly(props: ComponentProps<typeof LocalOnly>) {
  return automationSourceIsCloud() ? props.children : <LocalOnly {...props} />;
}
