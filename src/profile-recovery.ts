import { normalizeHostUrl, type MobileSecureStore } from "@takosjp/mobile-kit";
import { validMobileActorApId } from "./profile-api.ts";
import { decodeMobileUploadReference, type MobileUploadedAttachment } from "./api.ts";
import { normalizeProfilePatch, profileFormKeys, type MobileProfileForm, type MobileProfilePatch } from "./profile-edit-api.ts";

export interface ProfileRecoveryScope {
  readonly product: "yurucommu"; readonly hostUrl: string; readonly actorApId: string; readonly apiBaseUrl?: string;
}
export interface ProfileRecoverySnapshot {
  readonly base: MobileProfileForm; readonly draft: MobileProfileForm;
  readonly attempted?: { readonly draft: MobileProfileForm; readonly patch: MobileProfilePatch };
  readonly images?: Partial<Record<"icon_url" | "header_url",
    { readonly phase: "ready"; readonly name: string; readonly upload: MobileUploadedAttachment } |
    { readonly phase: "reselect"; readonly name: string }>>;
}
export class ProfileRecoveryError extends Error {
  constructor(readonly code: "invalid-scope" | "invalid-data" | "storage" | "secure-store-unavailable", options?: ErrorOptions) {
    super("Profile recovery: " + code, options); this.name = "ProfileRecoveryError";
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
  if (typeof value !== "string" || value.length > maximum || new TextEncoder().encode(value).byteLength > maximum) throw new ProfileRecoveryError("invalid-data");
}
function form(value: unknown): MobileProfileForm {
  if (!object(value, profileFormKeys) || typeof value.is_private !== "boolean" || !Array.isArray(value.fields) || value.fields.length > 4) throw new ProfileRecoveryError("invalid-data");
  // Preserve partially typed or invalid input for editing. The real API
  // validator still decides which values may be sent to the server.
  for (const key of ["name", "summary", "icon_url", "header_url"] as const) bounded(value[key], 64 * 1024);
  const fields = value.fields.map(row => {
    if (!object(row, ["name", "value"])) throw new ProfileRecoveryError("invalid-data");
    bounded(row.name, 4096); bounded(row.value, 4096); return { name: row.name, value: row.value };
  });
  return { name: value.name as string, summary: value.summary as string, icon_url: value.icon_url as string,
    header_url: value.header_url as string, is_private: value.is_private, fields };
}
function snapshot(value: unknown, host: string): ProfileRecoverySnapshot {
  try {
    if (!object(value, ["base", "draft", "attempted", "images"])) throw new Error();
    let attempted: ProfileRecoverySnapshot["attempted"];
    if (value.attempted !== undefined) {
      const item = value.attempted;
      if (!object(item, ["draft", "patch"]) || !object(item.patch, profileFormKeys)) throw new Error();
      const rawPatch = item.patch;
      const submitted = form(item.draft), patch = normalizeProfilePatch(rawPatch as MobileProfilePatch), normalized = normalizeProfilePatch(submitted);
      if (!Object.keys(patch).length || Object.keys(patch).length !== Object.keys(rawPatch).length ||
        Object.keys(patch).some(key => JSON.stringify(patch[key as keyof MobileProfileForm]) !== JSON.stringify(normalized[key as keyof MobileProfileForm]) ||
          JSON.stringify(patch[key as keyof MobileProfileForm]) !== JSON.stringify(rawPatch[key]))) throw new Error();
      attempted = { draft: submitted, patch };
    }
    const draft = form(value.draft), images: NonNullable<ProfileRecoverySnapshot["images"]> = {};
    if (value.images !== undefined) {
      if (!object(value.images, ["icon_url", "header_url"])) throw new Error();
      for (const key of ["icon_url", "header_url"] as const) {
        const image = value.images[key]; if (image === undefined) continue;
        if (!object(image, ["phase", "name", "upload"])) throw new Error();
        bounded(image.name, 4096); if (!image.name) throw new Error();
        if (image.phase === "reselect" && image.upload === undefined) images[key] = { phase: "reselect", name: image.name };
        else if (image.phase === "ready") {
          const receipt = image.upload;
          if (!object(receipt, ["r2_key", "url", "content_type", "name", "expiresAt"]) || receipt.name !== image.name ||
            typeof receipt.content_type !== "string" || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(receipt.content_type)) throw new Error();
          const upload = decodeMobileUploadReference(host, { name: image.name, type: receipt.content_type }, {
            r2_key: receipt.r2_key, url: receipt.url, content_type: receipt.content_type,
            ...(receipt.expiresAt === undefined ? {} : { expires_at: receipt.expiresAt }),
          });
          if (upload.url !== draft[key]) throw new Error();
          images[key] = { phase: "ready", name: image.name, upload };
        } else throw new Error();
      }
    }
    return { base: form(value.base), draft, ...(attempted ? { attempted } : {}), ...(Object.keys(images).length ? { images } : {}) };
  } catch { throw new ProfileRecoveryError("invalid-data"); }
}
const queues = new WeakMap<MobileSecureStore, Promise<void>>();
export function createProfileRecoveryStore(options: { store: MobileSecureStore; scope: ProfileRecoveryScope }) {
  const store = options.store;
  if (!store || store.kind !== "secure" || typeof store.get !== "function" || typeof store.set !== "function" || typeof store.delete !== "function") throw new ProfileRecoveryError("secure-store-unavailable");
  let scope: ProfileRecoveryScope;
  try {
    const input = options.scope;
    if (!object(input, ["product", "hostUrl", "actorApId", "apiBaseUrl"]) || input.product !== "yurucommu" || typeof input.hostUrl !== "string" || !validMobileActorApId(input.actorApId)) throw new Error();
    bounded(input.hostUrl, 2048);
    const host = normalizeHostUrl(input.hostUrl), original = new URL(input.hostUrl);
    if (original.pathname !== "/" || original.username || original.password || original.search || original.hash) throw new Error();
    if (input.apiBaseUrl !== undefined) {
      bounded(input.apiBaseUrl, 4096);
      const api = new URL(input.apiBaseUrl as string);
      if (api.origin !== host || api.username || api.password || api.search || api.hash) throw new Error();
    }
    scope = { product: "yurucommu", hostUrl: host, actorApId: input.actorApId as string,
      ...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl as string }) };
  } catch { throw new ProfileRecoveryError("invalid-scope"); }
  Object.freeze(scope);
  let key: Promise<string> | undefined;
  const storageKey = () => key ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    scope.product, scope.hostUrl, scope.actorApId, scope.apiBaseUrl ?? null,
  ]))).then(bytes => "yurucommu:profile-recovery:scope:v1:" + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
  cause => { key = undefined; throw cause; });
  function queued<T>(work: () => Promise<T>) {
    const next = (queues.get(store) ?? Promise.resolve()).then(work); queues.set(store, next.then(() => {}, () => {})); return next;
  }
  function decode(raw: string, owner: string) {
    try {
      bounded(raw, 256 * 1024); const value: unknown = JSON.parse(raw);
      if (!object(value, ["version", "scope", "savedAt", "data"]) || value.version !== 1 || value.scope !== owner ||
        !Number.isSafeInteger(value.savedAt) || (value.savedAt as number) < 0 || (value.savedAt as number) > Date.now()) throw new Error();
      return snapshot(value.data, scope.hostUrl);
    } catch { throw new ProfileRecoveryError("invalid-data"); }
  }
  return {
    scope,
    actorApId: scope.actorApId,
    load: () => queued(async (): Promise<ProfileRecoverySnapshot | null> => {
      try { const owner = await storageKey(), raw = await store.get(owner); return raw === undefined ? null : decode(raw, owner); }
      catch (cause) { if (cause instanceof ProfileRecoveryError) throw cause; throw new ProfileRecoveryError("storage", { cause }); }
    }),
    async save(input: ProfileRecoverySnapshot) {
      const data = snapshot(input, scope.hostUrl);
      return queued(async () => {
        try {
          const owner = await storageKey(), raw = await store.get(owner); if (raw !== undefined) decode(raw, owner);
          const encoded = JSON.stringify({ version: 1, scope: owner, savedAt: Date.now(), data }); bounded(encoded, 256 * 1024);
          await store.set(owner, encoded);
        } catch (cause) { if (cause instanceof ProfileRecoveryError) throw cause; throw new ProfileRecoveryError("storage", { cause }); }
      });
    },
  };
}
export type ProfileRecoveryPort = ReturnType<typeof createProfileRecoveryStore>;
