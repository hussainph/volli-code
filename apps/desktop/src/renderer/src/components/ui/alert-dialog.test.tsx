import { describe, expect, it } from "vite-plus/test";
import { AlertDialogAction, AlertDialogCancel, AlertDialogFooter } from "./alert-dialog";

describe("AlertDialog actions", () => {
  it("gives cancel and commit the same compact, label-sized geometry", () => {
    const cancel = AlertDialogCancel({ children: "Keep editing" });
    const action = AlertDialogAction({ children: "Discard", variant: "destructive" });
    expect(cancel.props.size).toBe("default");
    expect(action.props.size).toBe("default");
    expect(cancel.props.variant).toBe("outline");
    expect(action.props.variant).toBe("destructive");
    expect(AlertDialogFooter({}).props.className).not.toContain("min-w-20");
  });

  it("retains an explicit caller size", () => {
    expect(AlertDialogAction({ size: "sm" }).props.size).toBe("sm");
    expect(AlertDialogCancel({ size: "lg" }).props.size).toBe("lg");
  });
});
