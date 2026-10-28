/** Cloud images use signed GETs over connect-src, then inert data URLs over the
 * existing img-src policy. Never fall back to this Mac's blob store in a cloud
 * launch: identical hashes do not confer access to a private Session.
 */
import * as React from "react";
import { blobUrl, isBlobHash, parseBlobUrl } from "@volli/shared";
import { cloudSession, followCloudSession } from "@renderer/lib/cloud-client";
import { launchStore } from "@renderer/stores/launch";

export const MARKDOWN_IMAGE_MISSING_CLASS = "typeset-image-missing";

type BlobReader = (src: string) => Promise<string>;
const BlobReaderContext = React.createContext<BlobReader | null>(null);
const unavailable: BlobReader = async () => {
  throw new Error("Attachment unavailable");
};

export function useBlobReader(): BlobReader | null {
  const reader = React.useContext(BlobReaderContext);
  return launchStore() === "cloud" ? (reader ?? unavailable) : null;
}

export function BlobReadProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const session = React.useSyncExternalStore(followCloudSession, cloudSession, () => null);
  const reader = React.useMemo<BlobReader>(() => {
    // Window/account-scoped and bounded; no signed URLs or bytes persist.
    const cache = new Map<string, Promise<string>>();
    return async (src) => {
      const sha256 = parseBlobUrl(src);
      if (sha256 === null) return src;
      if (session === null) return unavailable(src);
      let pending = cache.get(sha256);
      if (pending === undefined) {
        pending = (async () => {
          const grant = await session.client.action(session.api.files.presignGet, {
            projectId,
            sha256,
          });
          if (!/^image\/[a-z0-9.+-]+$/i.test(grant.mime)) throw new Error("Not an image");
          const response = await fetch(grant.request.url, {
            method: "GET",
            headers: grant.request.headers,
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
          });
          if (!response.ok) throw new Error("Attachment could not be loaded");
          const bytes = await response.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const hex = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          if (bytes.byteLength !== grant.bytes || hex !== sha256)
            throw new Error("Attachment checksum mismatch");
          return new Promise<string>((resolve, reject) => {
            const file = new FileReader();
            file.addEventListener("load", () => resolve(String(file.result)), { once: true });
            file.addEventListener(
              "error",
              () => reject(new Error("Attachment could not be loaded")),
              { once: true },
            );
            file.readAsDataURL(new Blob([bytes], { type: grant.mime }));
          });
        })();
        cache.set(sha256, pending);
        if (cache.size > 16) cache.delete(cache.keys().next().value!);
        void pending.catch(() => {
          if (cache.get(sha256) === pending) cache.delete(sha256);
        });
      }
      return pending;
    };
  }, [session, projectId]);
  return <BlobReaderContext.Provider value={reader}>{children}</BlobReaderContext.Provider>;
}

/** Shared by transcript thumbnails and React markdown. */
export function BlobImage({ src, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const reader = useBlobReader();
  const hash = parseBlobUrl(src ?? "");
  const [loaded, setLoaded] = React.useState<{
    reader: BlobReader;
    src: string;
    value: string | null;
  } | null>(null);
  React.useEffect(() => {
    if (reader === null || hash === null || src === undefined) return;
    let cancelled = false;
    void reader(src).then(
      (value) => {
        if (!cancelled) setLoaded({ reader, src, value });
      },
      () => {
        if (!cancelled) setLoaded({ reader, src, value: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reader, hash, src]);
  if (reader === null || hash === null) return <img {...props} src={src} />;
  const current = loaded?.reader === reader && loaded.src === src ? loaded : null;
  if (current?.value === null)
    return (
      <span role="img" aria-label={props.alt} className={props.className} title={props.title}>
        Image could not be loaded
      </span>
    );
  return (
    <img
      {...props}
      src={current?.value ?? undefined}
      onError={(event) => {
        props.onError?.(event);
        if (src !== undefined) setLoaded({ reader, src, value: null });
      }}
    />
  );
}

/** Hydrates the inert image placeholders emitted by the sanitized HTML pipeline.
 * Keep all async image state out of its HTML renderer, with scope changes and
 * unmounts fenced the same way as BlobImage.
 */
export function useCloudMarkdownImages(
  container: React.RefObject<HTMLElement | null>,
  html: string,
): void {
  const reader = useBlobReader();
  React.useEffect(() => {
    if (reader === null) return;
    let cancelled = false;
    const notices: HTMLElement[] = [];
    const cleanups: Array<() => void> = [];
    for (const image of container.current?.querySelectorAll<HTMLImageElement>(
      "img[data-volli-blob]",
    ) ?? []) {
      const hash = image.dataset.volliBlob;
      if (hash === undefined || !isBlobHash(hash)) continue;
      image.removeAttribute("src");
      image.hidden = true;
      let failed = false;
      const fail = () => {
        if (cancelled || failed) return;
        failed = true;
        image.hidden = true;
        const notice = document.createElement("span");
        notice.className = MARKDOWN_IMAGE_MISSING_CLASS;
        notice.textContent = `Image could not be loaded${image.alt ? ` — ${image.alt}` : ""}`;
        image.after(notice);
        notices.push(notice);
      };
      image.addEventListener("error", fail);
      cleanups.push(() => image.removeEventListener("error", fail));
      void reader(blobUrl(hash)).then((src) => {
        if (!cancelled) {
          image.src = src;
          image.hidden = false;
        }
      }, fail);
    }
    return () => {
      cancelled = true;
      for (const notice of notices) notice.remove();
      for (const cleanup of cleanups) cleanup();
    };
  }, [container, html, reader]);
}

/** The local canonical source; BlobImage resolves it only in a cloud launch. */
export function AttachmentImage({
  hash,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & { hash: string }) {
  return <BlobImage {...props} src={blobUrl(hash)} />;
}
