/**
 * Settings → Account (VC-884; its GitHub section, VC-897): its rail entry,
 * first under Services. Only with the `cloud` experiment on
 * (`settingsGroups`'s `account` option); with it off the category does not
 * exist.
 */
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";

import type { PrefCategory } from "./kit";
import { AccountPane } from "./panes/account-pane";

const ACCOUNT_CATEGORY_KEY = "account";

export function accountCategory(): PrefCategory {
  return {
    key: ACCOUNT_CATEGORY_KEY,
    label: "Account",
    icon: UserCircleIcon,
    keywords: [
      "account",
      "volli cloud",
      "cloud",
      "sign in",
      "sign out",
      "log in",
      "log out",
      "github",
      "google",
      "continue with github",
      "continue with google",
      "name",
      "email",
      "delete account",
      "restore account",
      "deletion",
      "scheduled",
      "connected",
      "offline",
      "github accounts",
      "connect github",
      "reconnect",
      "disconnect",
      "install on an account",
      "configure on github",
      "repositories",
    ],
    content: <AccountPane />,
  };
}
