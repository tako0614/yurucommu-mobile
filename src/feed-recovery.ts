import { mobileAccountIdentity, normalizeHostUrl, type MobileAccountList, type MobileAccountSummary,
  type MobileSecureStore, type MobileSession } from "@takosjp/mobile-kit";
import { decodeMobileUploadReference, type MobilePostVisibility, type MobileUploadedAttachment } from "./api.ts";

export class FeedRecoveryError extends Error {
  constructor(readonly code: "invalid-scope" | "invalid-data" | "secure-store-unavailable" | "retired" | "storage", options?: ErrorOptions) {
    super("Feed recovery: " + code, options); this.name = "FeedRecoveryError";
  }
}
export interface FeedRecoveryScope {
  readonly product: "yurucommu"; readonly hostUrl: string; readonly actorApId: string; readonly apiBaseUrl?: string;
}
export type FeedRecoveryAttachment =
  | { readonly phase: "ready"; readonly upload: MobileUploadedAttachment }
  | { readonly phase: "reselect"; readonly name: string; readonly contentType: string; readonly size?: number };
export interface FeedRecoveryIntent {
  readonly id: string; readonly phase: "pending" | "uncertain"; readonly content: string;
  readonly visibility: MobilePostVisibility; readonly media: readonly MobileUploadedAttachment[];
}
export interface FeedRecoverySnapshot {
  readonly content: string; readonly visibility: MobilePostVisibility;
  readonly attachments: readonly FeedRecoveryAttachment[]; readonly intent?: FeedRecoveryIntent;
}
export type FeedRecoveryPort = Pick<ReturnType<typeof createFeedRecoveryStore>, "load" | "save">;
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && keys.includes(key) && property.enumerable && Object.hasOwn(property, "value");
  });
}
function short(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && new TextEncoder().encode(value).byteLength <= limit * 4;
}
function visibility(value: unknown): value is MobilePostVisibility {
  return value === "public" || value === "unlisted" || value === "followers" || value === "direct";
}
function upload(value: unknown, host: string): MobileUploadedAttachment {
  if (!object(value, ["r2_key", "url", "content_type", "name", "expiresAt"]) || !short(value.name, 255) || !value.name ||
    typeof value.content_type !== "string") throw new FeedRecoveryError("invalid-data");
  return decodeMobileUploadReference(host, { name: value.name, type: value.content_type }, {
    r2_key: value.r2_key, url: value.url, content_type: value.content_type,
    ...(value.expiresAt === undefined ? {} : { expires_at: value.expiresAt }),
  });
}
function snapshot(value: unknown, host: string): FeedRecoverySnapshot {
  try {
    if (!object(value, ["content", "visibility", "attachments", "intent"]) || !short(value.content, 500) ||
      !visibility(value.visibility) || !Array.isArray(value.attachments) || value.attachments.length > 8) throw new Error();
    const attachments: FeedRecoveryAttachment[] = value.attachments.map(item => {
      if (object(item, ["phase", "upload"]) && item.phase === "ready") {
        const parsed = upload(item.upload, host);
        return parsed.expiresAt !== undefined && Date.parse(parsed.expiresAt) <= Date.now()
          ? { phase: "reselect", name: parsed.name!, contentType: parsed.content_type! }
          : { phase: "ready", upload: parsed };
      }
      if (!object(item, ["phase", "name", "contentType", "size"]) || item.phase !== "reselect" || !short(item.name, 512) || !item.name ||
        typeof item.contentType !== "string" || !short(item.contentType, 128) ||
        (item.size !== undefined && (!Number.isSafeInteger(item.size) || (item.size as number) < 0))) throw new Error();
      return { phase: "reselect", name: item.name, contentType: item.contentType, ...(item.size === undefined ? {} : { size: item.size as number }) };
    });
    let intent: FeedRecoveryIntent | undefined;
    if (value.intent !== undefined) {
      const item = value.intent;
      if (!object(item, ["id", "phase", "content", "visibility", "media"]) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id) ||
        (item.phase !== "pending" && item.phase !== "uncertain") || !short(item.content, 500) || !item.content.trim() ||
        !visibility(item.visibility) || !Array.isArray(item.media) || item.media.length > 8) throw new Error();
      intent = { id: item.id, phase: item.phase, content: item.content, visibility: item.visibility,
        media: item.media.map(value => upload(value, host)) };
    }
    return { content: value.content, visibility: value.visibility, attachments, ...(intent ? { intent } : {}) };
  } catch { throw new FeedRecoveryError("invalid-data"); }
}
const queues = new WeakMap<MobileSecureStore, Promise<void>>();
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function createFeedRecoveryStore(options: { store: MobileSecureStore; scope: FeedRecoveryScope }) {
  const store = options.store, scope = options.scope;
  if (!store || store.kind !== "secure" || typeof store.get !== "function" || typeof store.set !== "function" || typeof store.delete !== "function") {
    throw new FeedRecoveryError("secure-store-unavailable");
  }
  let host: string;
  try {
    if (!object(scope, ["product", "hostUrl", "actorApId", "apiBaseUrl"]) || !short(scope.hostUrl, 2048)) throw new Error();
    host = normalizeHostUrl(scope.hostUrl);
    const original = new URL(scope.hostUrl);
    if (original.pathname !== "/" || original.search || original.hash || original.username || original.password ||
      scope.product !== "yurucommu" || !short(scope.actorApId, 2048) || !scope.actorApId.trim() || /[\u0000-\u0020\u007f]/u.test(scope.actorApId)) throw new Error();
    if (scope.apiBaseUrl !== undefined) {
      const api = new URL(scope.apiBaseUrl);
      if (api.origin !== host || api.username || api.password || api.search || api.hash) throw new Error();
    }
  } catch { throw new FeedRecoveryError("invalid-scope"); }
  let key: Promise<string> | undefined;
  const storageKey = () => key ??= digest(JSON.stringify([scope.product, host, scope.actorApId, scope.apiBaseUrl ?? null]))
    .then(value => "yurucommu:feed-recovery:scope:v1:" + value, cause => { key = undefined; throw cause; });
  function queued<T>(work: () => Promise<T>) {
    const next = (queues.get(store) ?? Promise.resolve()).then(work); queues.set(store, next.then(() => {}, () => {})); return next;
  }
  function decodeSnapshot(raw: string, owner: string) {
    try {
      bounded(raw, 256 * 1024);
      const value: unknown = JSON.parse(raw);
      if (!object(value, ["version", "scope", "savedAt", "data"]) || value.version !== 1 || value.scope !== owner ||
        !Number.isSafeInteger(value.savedAt) || (value.savedAt as number) < 0 || (value.savedAt as number) > Date.now()) throw new FeedRecoveryError("invalid-data");
      return snapshot(value.data, host);
    } catch (cause) { if (cause instanceof FeedRecoveryError) throw cause; throw new FeedRecoveryError("invalid-data"); }
  }
  return {
    load: () => queued(async (): Promise<FeedRecoverySnapshot | null> => {
      try { const owner = await storageKey(), raw = await store.get(owner); return raw === undefined ? null : decodeSnapshot(raw, owner); }
      catch (cause) { if (cause instanceof FeedRecoveryError) throw cause; throw new FeedRecoveryError("storage", { cause }); }
    }),
    save: async (input: FeedRecoverySnapshot) => {
      const data = snapshot(input, host);
      return queued(async () => {
        try {
          const owner = await storageKey(), previous = await store.get(owner);
          if (previous !== undefined) decodeSnapshot(previous, owner);
          const raw = JSON.stringify({ version: 1, scope: owner, savedAt: Date.now(), data }); bounded(raw, 256 * 1024);
          await store.set(owner, raw);
        } catch (cause) { if (cause instanceof FeedRecoveryError) throw cause; throw new FeedRecoveryError("storage", { cause }); }
      });
    },
  };
}

type Account = Pick<MobileAccountSummary, "id" | "hostUrl" | "product">;
type IndexedAccount = Account & { cleanupPending: boolean };
type Entry = readonly [string, string];
interface AccountState {
  readonly store: MobileSecureStore;
  active: () => void;
  retire: () => Promise<void>;
}
const accounts = new WeakMap<MobileSecureStore, Map<string, AccountState>>();
const indexQueues = new WeakMap<MobileSecureStore, Promise<void>>();
const indexKey = "yurucommu:feed-recovery:accounts:v1";
const maxEnvelopeBytes = 4 * 1024 * 1024;
const scopeKey = /^yurucommu:feed-recovery:scope:v1:[a-f0-9]{64}$/u;

function bounded(value: unknown, limit: number): asserts value is string {
  if (typeof value !== "string" || value.length > limit || new TextEncoder().encode(value).byteLength > limit) {
    throw new FeedRecoveryError("invalid-data");
  }
}

function identity(account: Account) {
  try {
    if (account.product !== "yurucommu" || typeof account.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(account.id) ||
      typeof account.hostUrl !== "string" || account.hostUrl.length > 2048 || /[\u0000-\u0020\u007f]/u.test(account.hostUrl)) throw new Error();
    const host = normalizeHostUrl(account.hostUrl), parsed = new URL(account.hostUrl);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    return { host, value: JSON.stringify([account.product, host, account.id]),
      row: { id: account.id, hostUrl: host, product: "yurucommu" as const } };
  } catch { throw new FeedRecoveryError("invalid-scope"); }
}

function decode(raw: string | undefined, owner: string): Entry[] {
  if (raw === undefined) return [];
  try {
    bounded(raw, maxEnvelopeBytes);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "owner", "entries"].includes(key))) throw new Error();
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || data.owner !== owner || !Array.isArray(data.entries) || data.entries.length > 32) throw new Error();
    const seen = new Set<string>();
    return data.entries.map(item => {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !scopeKey.test(item[0]) || seen.has(item[0])) throw new Error();
      bounded(item[1], 1024 * 1024);
      seen.add(item[0]);
      return [item[0], item[1]];
    });
  } catch { throw new FeedRecoveryError("invalid-data"); }
}

/** Encrypted row namespace only; account metadata grants no server authority. */
export function createFeedRecoveryAccounts(options: { store?: MobileSecureStore }) {
  const selectedStore = options.store;
  if (!selectedStore || selectedStore.kind !== "secure" || typeof selectedStore.get !== "function" || typeof selectedStore.set !== "function" || typeof selectedStore.delete !== "function") {
    throw new FeedRecoveryError("secure-store-unavailable");
  }
  const store: MobileSecureStore = selectedStore;
  const shared = accounts.get(store) ?? new Map<string, AccountState>();
  accounts.set(store, shared);
  function indexed<T>(work: () => Promise<T>): Promise<T> {
    const next = (indexQueues.get(store) ?? Promise.resolve()).then(work);
    indexQueues.set(store, next.then(() => {}, () => {}));
    return next;
  }
  async function readIndex(): Promise<IndexedAccount[]> {
    const raw = await store.get(indexKey);
    if (raw === undefined) return [];
    try {
      bounded(raw, 512 * 1024);
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 ||
        Object.keys(data).some(key => !["version", "rows"].includes(key)) || !Array.isArray(data.rows) || data.rows.length > 128) throw new Error();
      const seen = new Set<string>();
      return data.rows.map((row: unknown) => {
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["id", "hostUrl", "product", "cleanupPending"].includes(key))) throw new Error();
        const selected = identity(row as Account);
        if (typeof (row as IndexedAccount).cleanupPending !== "boolean") throw new Error();
        if (seen.has(selected.value)) throw new Error();
        seen.add(selected.value);
        return { ...selected.row, cleanupPending: (row as IndexedAccount).cleanupPending };
      });
    } catch { throw new FeedRecoveryError("invalid-data"); }
  }
  function registerRow(value: string, cleanupPending = false) {
    return indexed(async () => {
      const rows = await readIndex();
      const existing = rows.find(row => identity(row).value === value);
      if (existing && (!cleanupPending || existing.cleanupPending)) return;
      if (!existing && rows.length >= 128) throw new FeedRecoveryError("invalid-data");
      const [product, hostUrl, id] = JSON.parse(value);
      const row = { ...identity({ product, hostUrl, id }).row, cleanupPending };
      const next = existing ? rows.map(item => identity(item).value === value ? row : item) : [...rows, row];
      const raw = JSON.stringify({ version: 1, rows: next });
      bounded(raw, 512 * 1024);
      await store.set(indexKey, raw);
    });
  }
  function unregisterRow(value: string) {
    return indexed(async () => {
      const previous = await readIndex(), rows = previous.filter(row => identity(row).value !== value);
      if (rows.length === previous.length) return;
      if (rows.length) await store.set(indexKey, JSON.stringify({ version: 1, rows }));
      else await store.delete(indexKey);
    });
  }
  function accountState(value: string): AccountState {
    const previous = shared.get(value);
    if (previous) return previous;
    let tail = Promise.resolve(), key: Promise<string> | undefined;
    let retired = false, retirement: Promise<void> | undefined;
    function active() { if (retired) throw new FeedRecoveryError("retired"); }
    function queued<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work);
      tail = next.then(() => {}, () => {});
      return next;
    }
    function storageKey(): Promise<string> {
      key ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then(bytes =>
        "yurucommu:feed-recovery:account:v1:" + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
      cause => { key = undefined; throw cause; });
      return key;
    }
    const adapter: MobileSecureStore = {
      kind: "secure",
      get: name => queued(async () => {
        active();
        const owner = await storageKey();
        active();
        const raw = await store.get(owner);
        active();
        return decode(raw, owner).find(([key]) => key === name)?.[1];
      }),
      set: (name, raw) => queued(async () => {
        active();
        if (!scopeKey.test(name)) throw new FeedRecoveryError("invalid-data");
        bounded(raw, 1024 * 1024);
        const owner = await storageKey();
        active();
        const previous = await store.get(owner);
        active();
        const entries = decode(previous, owner).filter(([key]) => key !== name);
        if (entries.length >= 32) throw new FeedRecoveryError("invalid-data");
        entries.push([name, raw]);
        const encoded = JSON.stringify({ version: 1, owner, entries });
        bounded(encoded, maxEnvelopeBytes);
        // The discoverable row must be durable before any private payload.
        await registerRow(value);
        active();
        await store.set(owner, encoded);
        active();
      }),
      delete: name => queued(async () => {
        active();
        const owner = await storageKey();
        active();
        const previous = await store.get(owner);
        active();
        const entries = decode(previous, owner).filter(([key]) => key !== name);
        if (!entries.length) await store.delete(owner);
        else await store.set(owner, JSON.stringify({ version: 1, owner, entries }));
        active();
      }),
    };
    function retire() {
      retired = true;
      retirement ??= queued(async () => {
        try {
          // Only a genuine row-retirement notification establishes this intent.
          // Persist it before deleting; absence from a normalized list is insufficient.
          await registerRow(value, true);
          await store.delete(await storageKey());
          await unregisterRow(value);
        }
        catch (cause) { throw new FeedRecoveryError("storage", { cause }); }
      }).catch(cause => { retirement = undefined; throw cause; });
      return retirement;
    }
    const result = { store: adapter, active, retire };
    shared.set(value, result);
    return result;
  }
  function bind(account: Account, scope: FeedRecoveryScope) {
    const selected = identity(account);
    if (scope.product !== "yurucommu" || normalizeHostUrl(scope.hostUrl) !== selected.host) throw new FeedRecoveryError("invalid-scope");
    const state = accountState(selected.value);
    state.active();
    return createFeedRecoveryStore({ store: state.store, scope });
  }
  return {
    bind,
    select(input: { accounts: MobileAccountList; session: MobileSession; actorApId: string }) {
      const rows = input.accounts.accounts.filter(row => row.id === input.accounts.activeId);
      if (input.session.product !== "yurucommu" || rows.length !== 1 || rows[0].product !== "yurucommu" ||
        mobileAccountIdentity(rows[0]) !== mobileAccountIdentity(input.session)) throw new FeedRecoveryError("invalid-scope");
      return bind(rows[0], { product: "yurucommu", hostUrl: input.session.hostUrl, actorApId: input.actorApId,
        ...(input.session.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.session.apiBaseUrl }) });
    },
    retire: (account: Account) => accountState(identity(account).value).retire(),
    async pendingCleanup(saved: MobileAccountList): Promise<Account[]> {
      if (!saved || !Array.isArray(saved.accounts) || saved.accounts.length > 32) throw new FeedRecoveryError("invalid-scope");
      const current = new Set(saved.accounts.map(row => identity(row).value));
      if (current.size !== saved.accounts.length) throw new FeedRecoveryError("invalid-scope");
      return indexed(async () => (await readIndex())
        .filter(row => row.cleanupPending && !current.has(identity(row).value)).map(row => identity(row).row));
    },
  };
}
