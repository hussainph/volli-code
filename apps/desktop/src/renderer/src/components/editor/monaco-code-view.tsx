import * as React from "react";
import type { editor } from "monaco-editor";

import { documentIdentityKey, type DocumentIdentity } from "@renderer/editor/document-identity";
import type { DocumentLease, DocumentRevision } from "@renderer/editor/document-registry";
import { loadMonacoRuntime, startModelLanguageWorker } from "@renderer/editor/monaco-runtime";

interface MonacoCodeViewProps {
  identity: DocumentIdentity;
  value: string;
  revision: DocumentRevision;
  viewId: string;
  ariaLabel: string;
}

type MonacoLease = DocumentLease<editor.ITextModel, editor.ICodeEditorViewState>;

interface SeedRef {
  key: string;
  value: string;
  revision: DocumentRevision;
}

/**
 * A thin React owner for one Monaco editor view. Models and view state belong
 * to the shared registry; this component owns only the disposable editor DOM.
 */
export function MonacoCodeView({
  identity,
  value,
  revision,
  viewId,
  ariaLabel,
}: MonacoCodeViewProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const leaseRef = React.useRef<{ key: string; lease: MonacoLease } | null>(null);
  const key = documentIdentityKey(identity);
  const identityRef = React.useRef({ key, identity });
  identityRef.current = { key, identity };
  const seedRef = React.useRef<SeedRef>({ key, value, revision });
  seedRef.current = { key, value, revision };
  const [failure, setFailure] = React.useState<{ key: string; message: string } | null>(null);
  const failedForCurrentDocument = failure?.key === key;

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    let editorView: editor.IStandaloneCodeEditor | null = null;
    let lease: MonacoLease | null = null;
    host.dataset.monacoStatus = "loading";
    host.dataset.monacoReadOnly = "true";

    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;

        const seed = seedRef.current;
        const activeIdentity = identityRef.current;
        if (seed.key !== key || activeIdentity.key !== key) return;
        lease = runtime.registry.acquire({
          identity: activeIdentity.identity,
          viewId,
          seed: { value: seed.value, revision: seed.revision },
          savePolicy: "read-only",
        });
        leaseRef.current = { key, lease };

        if (cancelled) {
          lease.release();
          leaseRef.current = null;
          lease = null;
          return;
        }

        editorView = runtime.monaco.editor.create(host, {
          model: lease.model,
          theme: "volli-dark",
          readOnly: true,
          domReadOnly: true,
          ariaLabel,
          automaticLayout: true,
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 21,
          lineNumbers: "on",
          minimap: { enabled: false },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          renderLineHighlight: "none",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 12, bottom: 12 },
        });
        const restoredViewState = lease.restoreViewState();
        if (restoredViewState !== null) editorView.restoreViewState(restoredViewState);

        const language = lease.snapshot().language;
        host.dataset.monacoStatus = "ready";
        host.dataset.monacoLanguage = language;
        host.dataset.monacoWorker =
          language === "typescript" || language === "javascript" ? "starting" : "not-required";

        void startModelLanguageWorker(runtime, lease.model)
          .then((worker) => {
            if (cancelled) return;
            host.dataset.monacoWorker = worker === null ? "not-required" : "ready";
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            host.dataset.monacoWorker = "failed";
            console.error("Monaco language worker failed", error);
          });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        editorView?.dispose();
        editorView = null;
        lease?.release();
        lease = null;
        if (leaseRef.current?.key === key) leaseRef.current = null;
        const message = error instanceof Error ? error.message : String(error);
        console.error("Monaco code preview failed", error);
        setFailure({ key, message });
      });

    return () => {
      cancelled = true;
      if (leaseRef.current?.key === key) leaseRef.current = null;
      if (editorView !== null) {
        const viewState = editorView.saveViewState();
        editorView.dispose();
        lease?.release(viewState);
      } else {
        lease?.release();
      }
    };
  }, [ariaLabel, key, viewId]);

  // A read-only file never has a user draft to protect, so filesystem updates
  // can advance the registry's clean baseline in place.
  React.useEffect(() => {
    const active = leaseRef.current;
    if (active?.key !== key) return;
    active.lease.adoptCleanBaseline({ value, revision });
  }, [key, revision, value]);

  if (failedForCurrentDocument) {
    return (
      <pre
        data-monaco-fallback="true"
        title={`Monaco unavailable: ${failure.message}`}
        className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-ui text-foreground"
      >
        {value}
      </pre>
    );
  }

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
