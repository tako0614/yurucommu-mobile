import {
  apiFetch,
  clearYurucommuApiTransport,
  maxImageFileSize,
  maxVideoFileSize,
  setYurucommuApiTransport,
} from "@takosjp/yurucommu-api";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createYurucommuMobileTransport } from "./api.ts";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export interface MobileMediaSource {
  readonly kind: "image" | "video" | "unavailable";
  readonly label: string;
  readonly url?: string;
  readonly contentType?: string;
  readonly authenticated?: boolean;
}

const images = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const videos = new Set(["video/mp4", "video/webm"]);
const unavailable: MobileMediaSource = {
  kind: "unavailable",
  label: "添付ファイル",
};

/** Missing media is compatible with older feed responses; malformed media is visible. */
export function describeMobilePostMedia(
  value: unknown,
  hostUrl: string,
): readonly MobileMediaSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [unavailable];
  const host = new URL(hostUrl);
  return value.map((item): MobileMediaSource => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return unavailable;
    const entry = item as Record<string, unknown>;
    const label =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name
        : "添付ファイル";
    const bad = { ...unavailable, label };
    // Inbound ActivityPub attachments are projected by the public API with
    // mediaType; locally uploaded attachments use content_type.
    const contentType =
      entry.content_type === undefined ? entry.mediaType : entry.content_type;
    if (typeof contentType !== "string") return bad;
    const kind = images.has(contentType)
      ? "image"
      : videos.has(contentType)
        ? "video"
        : undefined;
    if (!kind) return bad;
    let raw = entry.url;
    if (raw === undefined || raw === null || raw === "") {
      if (typeof entry.r2_key !== "string") return bad;
      // Reuse the product's canonical uploads/<filename> -> /media/<filename> route.
      const filename = entry.r2_key.replace(/^uploads\//u, "");
      if (
        !filename ||
        /[\/\\\u0000-\u0020]/u.test(filename) ||
        filename.includes("..")
      )
        return bad;
      raw = `/media/${encodeURIComponent(filename)}`;
    }
    return describeMediaUrl(raw, host, label, kind, contentType);
  });
}

function describeMediaUrl(
  raw: unknown,
  host: URL,
  label: string,
  kind: "image" | "video",
  contentType: string,
): MobileMediaSource {
  if (
    typeof raw !== "string" ||
    raw !== raw.trim() ||
    /[\u0000-\u0020]/u.test(raw)
  )
    return { ...unavailable, label };
  let url: URL;
  try {
    url = new URL(raw, host);
  } catch {
    return { ...unavailable, label };
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.origin === host.origin))
  )
    return { ...unavailable, label };
  const local = url.origin === host.origin;
  // Only the canonical media route may receive the native bearer.
  if (local && (!/^\/media\/[^/]+$/u.test(url.pathname) || url.search))
    return { ...unavailable, label };
  return {
    kind,
    label,
    url: url.href,
    contentType,
    authenticated: local,
  };
}

/** Profile icon/header fields declare image context, not an invented MIME. */
export function describeMobileProfileImage(
  value: unknown,
  hostUrl: string,
  label = "プロフィール画像",
): readonly MobileMediaSource[] {
  if (value === undefined || value === null || value === "") return [];
  return [describeMediaUrl(value, new URL(hostUrl), label, "image", "image/*")];
}

/** Authenticated media stays on the selected host, never following a redirect. */
export async function loadMobileMediaBlob(
  session: MobileSession,
  source: MobileMediaSource,
  signal: AbortSignal,
): Promise<Blob> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Bound the entire body read, including a stream that stalls after headers.
  const deadline = setTimeout(
    () => controller.abort(new Error("添付の読み込みがタイムアウトしました。")),
    15_000,
  );
  try {
    return await readMobileMediaBlob(session, source, controller.signal);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }
}

async function readMobileMediaBlob(
  session: MobileSession,
  source: MobileMediaSource,
  signal: AbortSignal,
): Promise<Blob> {
  if (!source.url || !source.authenticated || source.kind === "unavailable")
    throw new Error("この添付は認証付きで読み込めません。");
  const url = new URL(source.url);
  const host = new URL(session.hostUrl);
  if (
    url.origin !== host.origin ||
    !/^\/media\/[^/]+$/u.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("添付の接続先を確認できませんでした。");
  const transport = createYurucommuMobileTransport(session);
  let request: Promise<Response>;
  setYurucommuApiTransport(transport);
  try {
    request = apiFetch(url.pathname, {
      // The outer deadline covers headers AND body. SDK3.4's default wrapper
      // detaches the caller signal at headers; its supported direct-signal
      // option keeps account cancellation/deadline attached to this stream.
      timeoutMs: 0,
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } finally {
    clearYurucommuApiTransport();
  }
  const response = await request;
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`添付を読み込めませんでした（${response.status}）。`);
  }
  const type = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const maximum = source.kind === "video" ? maxVideoFileSize : maxImageFileSize;
  if (
    (source.contentType === "image/*" && source.kind === "image"
      ? !images.has(type ?? "")
      : type !== source.contentType) ||
    !response.body ||
    Number(response.headers.get("content-length") ?? 0) > maximum
  ) {
    await response.body?.cancel();
    throw new Error("添付の形式またはサイズを確認できませんでした。");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum)
        throw new Error("添付がアプリで読み込めるサイズを超えています。");
      chunks.push(new Uint8Array(value));
    }
    if (!total) throw new Error("添付の内容が空でした。");
    return new Blob(chunks, { type });
  } catch (cause) {
    await reader.cancel().catch(() => {});
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

export interface MobileMediaState {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly url?: string;
  readonly error?: string;
}

/** A view owns its object URL and pending read, independently of other accounts. */
export function createMobileMediaController(options: {
  session: MobileSession;
  source: MobileMediaSource;
  onChange?: (state: MobileMediaState) => void;
  isActive?: () => boolean;
}) {
  let session = snapshotFeedSession(options.session),
    source = options.source;
  let key = feedSessionIdentity(session),
    sourceKey = JSON.stringify(source);
  let epoch = 0,
    disposed = false,
    objectUrl: string | undefined,
    pending: AbortController | undefined;
  let state: MobileMediaState = { phase: "idle" };
  const active = (expected: number) =>
    !disposed && epoch === expected && options.isActive?.() !== false;
  function release() {
    pending?.abort();
    pending = undefined;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  }
  function publish(next: MobileMediaState) {
    state = next;
    if (active(epoch)) options.onChange?.(state);
  }
  async function load() {
    if (
      !active(epoch) ||
      source.kind === "unavailable" ||
      state.phase === "loading" ||
      state.phase === "ready"
    )
      return;
    const expected = ++epoch;
    release();
    if (!source.authenticated) {
      publish({ phase: "ready", url: source.url });
      return;
    }
    pending = new AbortController();
    publish({ phase: "loading" });
    try {
      const blob = await loadMobileMediaBlob(
        snapshotFeedSession(session),
        source,
        pending.signal,
      );
      if (!active(expected)) return;
      objectUrl = URL.createObjectURL(blob);
      publish({ phase: "ready", url: objectUrl });
    } catch (cause) {
      if (active(expected))
        publish({
          phase: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "添付を読み込めませんでした。",
        });
    } finally {
      if (active(expected)) pending = undefined;
    }
  }
  function update(nextSession: MobileSession, nextSource: MobileMediaSource) {
    const nextKey = feedSessionIdentity(nextSession),
      nextSourceKey = JSON.stringify(nextSource);
    session = snapshotFeedSession(nextSession);
    source = nextSource;
    if (nextKey === key && nextSourceKey === sourceKey) return;
    key = nextKey;
    sourceKey = nextSourceKey;
    epoch += 1;
    release();
    publish({ phase: "idle" });
  }
  function failed(url: string | undefined) {
    if (!active(epoch) || state.phase !== "ready" || url !== state.url) return;
    epoch += 1;
    release();
    publish({
      phase: "error",
      error: "添付を表示できませんでした。再試行できます。",
    });
  }
  function dispose() {
    disposed = true;
    epoch += 1;
    release();
    state = { phase: "idle" };
  }
  return { getState: () => state, load, update, failed, dispose };
}
