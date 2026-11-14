import { normalizeHostUrl, type MobileSecureStore } from "@takosjp/mobile-kit";
import { validMobileActorApId } from "./profile-api.ts";
import { normalizePostEditPatch, type MobilePostEditForm, type MobilePostEditPatch } from "./post-edit-api.ts";

export interface PostEditRecoveryScope {
  readonly product: "yurucommu"; readonly hostUrl: string; readonly actorApId: string; readonly apiBaseUrl?: string;
  readonly postApId: string; readonly view: "post" | "profile";
}
export interface PostEditRecoverySnapshot {
  readonly base: MobilePostEditForm; readonly draft: MobilePostEditForm;
  readonly attempted?: { readonly draft: MobilePostEditForm; readonly patch: MobilePostEditPatch };
}
export interface PostEditInvalidRecoveryReview {
  discard: () => Promise<void>;
}
export class PostEditRecoveryError extends Error {
  constructor(readonly code: "invalid-scope" | "invalid-data" | "changed" | "storage" | "secure-store-unavailable", options?: ErrorOptions) {
    super("Post edit recovery: " + code, options); this.name = "PostEditRecoveryError";
  }
}
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && keys.includes(key) && property.enumerable && Object.hasOwn(property, "value");
  });
}
function bounded(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || new TextEncoder().encode(value).byteLength > maximum) throw new PostEditRecoveryError("invalid-data");
}
function form(value: unknown): MobilePostEditForm {
  if (!object(value, ["content", "summary"])) throw new PostEditRecoveryError("invalid-data");
  // Raw, including temporarily invalid input. Only the existing API validator
  // may decide which fields can be sent; saved bytes are never read provenance.
  bounded(value.content, 64 * 1024); bounded(value.summary, 64 * 1024);
  return { content: value.content, summary: value.summary };
}
function snapshot(value: unknown): PostEditRecoverySnapshot {
  try {
    if (!object(value, ["base", "draft", "attempted"])) throw new Error();
    let attempted: PostEditRecoverySnapshot["attempted"];
    if (value.attempted !== undefined) {
      const item = value.attempted;
      if (!object(item, ["draft", "patch"]) || !object(item.patch, ["content", "summary"])) throw new Error();
      const submitted = form(item.draft), patch = normalizePostEditPatch(item.patch as MobilePostEditPatch);
      if (!Object.keys(patch).length || Object.keys(patch).length !== Object.keys(item.patch).length ||
        Object.keys(patch).some(key => {
          const field = key as keyof MobilePostEditForm;
          return patch[field] !== submitted[field].trim() || patch[field] !== (item.patch as Record<string, unknown>)[field];
        })) throw new Error();
      attempted = { draft: submitted, patch };
    }
    return { base: form(value.base), draft: form(value.draft), ...(attempted ? { attempted } : {}) };
  } catch { throw new PostEditRecoveryError("invalid-data"); }
}
const queues = new WeakMap<MobileSecureStore, Promise<void>>();
export function createPostEditRecoveryStore(options: { store: MobileSecureStore; scope: PostEditRecoveryScope }) {
  const store = options.store;
  if (!store || store.kind !== "secure" || typeof store.get !== "function" || typeof store.set !== "function" || typeof store.delete !== "function") throw new PostEditRecoveryError("secure-store-unavailable");
  let scope: PostEditRecoveryScope;
  try {
    const input = options.scope;
    if (!object(input, ["product", "hostUrl", "actorApId", "apiBaseUrl", "postApId", "view"]) || input.product !== "yurucommu" || typeof input.hostUrl !== "string" ||
      !validMobileActorApId(input.actorApId) || !validMobileActorApId(input.postApId) || !["post", "profile"].includes(input.view)) throw new Error();
    bounded(input.hostUrl, 2048);
    const hostUrl = normalizeHostUrl(input.hostUrl), original = new URL(input.hostUrl);
    if (original.pathname !== "/" || original.username || original.password || original.search || original.hash) throw new Error();
    if (input.apiBaseUrl !== undefined) {
      bounded(input.apiBaseUrl, 4096); const api = new URL(input.apiBaseUrl);
      if (api.origin !== hostUrl || api.username || api.password || api.search || api.hash) throw new Error();
    }
    scope = { product: "yurucommu", hostUrl, actorApId: input.actorApId as string, postApId: input.postApId as string, view: input.view,
      ...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl as string }) };
  } catch { throw new PostEditRecoveryError("invalid-scope"); }
  Object.freeze(scope);
  let key: Promise<string> | undefined;
  const storageKey = () => key ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    scope.product, scope.hostUrl, scope.actorApId, scope.apiBaseUrl ?? null, scope.postApId, scope.view,
  ]))).then(bytes => "yurucommu:post-edit-recovery:scope:v1:" + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
  cause => { key = undefined; throw cause; });
  function queued<T>(work: () => Promise<T>) {
    const next = (queues.get(store) ?? Promise.resolve()).then(work); queues.set(store, next.then(() => {}, () => {})); return next;
  }
  function header(raw: string, owner: string) {
    try {
      bounded(raw, 256 * 1024); const value: unknown = JSON.parse(raw);
      if (!object(value, ["version", "scope", "savedAt", "data"]) || value.version !== 1 || value.scope !== owner ||
        !Number.isSafeInteger(value.savedAt) || (value.savedAt as number) < 0 || (value.savedAt as number) > Date.now()) throw new Error();
      return value.data;
    } catch { throw new PostEditRecoveryError("invalid-data"); }
  }
  function decode(raw: string, owner: string) { return snapshot(header(raw, owner)); }
  function verifyInvalidContents(raw: string, owner: string) {
    const data = header(raw, owner);
    // A foreign, unreadable or unsupported header cannot authorize deletion.
    try { snapshot(data); }
    catch (cause) { if (cause instanceof PostEditRecoveryError && cause.code === "invalid-data") return; throw cause; }
    throw new PostEditRecoveryError("changed");
  }
  return {
    scope,
    load: () => queued(async (): Promise<PostEditRecoverySnapshot | null> => {
      try { const owner = await storageKey(), raw = await store.get(owner); return raw === undefined ? null : decode(raw, owner); }
      catch (cause) { if (cause instanceof PostEditRecoveryError) throw cause; throw new PostEditRecoveryError("storage", { cause }); }
    }),
    async save(input: PostEditRecoverySnapshot) {
      const data = snapshot(input);
      return queued(async () => {
        try {
          const owner = await storageKey(), raw = await store.get(owner); if (raw !== undefined) decode(raw, owner);
          if (!data.attempted && data.base.content === data.draft.content && data.base.summary === data.draft.summary) {
            await store.delete(owner); return;
          }
          const encoded = JSON.stringify({ version: 1, scope: owner, savedAt: Date.now(), data }); bounded(encoded, 256 * 1024);
          await store.set(owner, encoded);
        } catch (cause) { if (cause instanceof PostEditRecoveryError) throw cause; throw new PostEditRecoveryError("storage", { cause }); }
      });
    },
    reviewInvalid: () => queued(async (): Promise<PostEditInvalidRecoveryReview> => {
      try {
        const owner = await storageKey(), raw = await store.get(owner);
        if (raw === undefined) throw new PostEditRecoveryError("changed");
        verifyInvalidContents(raw, owner);
        return { discard: () => queued(async () => {
          try {
            if (await store.get(owner) !== raw) throw new PostEditRecoveryError("changed");
            verifyInvalidContents(raw, owner);
            await store.delete(owner);
          } catch (cause) { if (cause instanceof PostEditRecoveryError) throw cause; throw new PostEditRecoveryError("storage", { cause }); }
        }) };
      } catch (cause) { if (cause instanceof PostEditRecoveryError) throw cause; throw new PostEditRecoveryError("storage", { cause }); }
    }),
  };
}
export type PostEditRecoveryPort = ReturnType<typeof createPostEditRecoveryStore>;
