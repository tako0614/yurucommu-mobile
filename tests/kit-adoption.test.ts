import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import {
  createMobileClientController,
  createTauriMobileDefaultProductBridge,
  loadMobileAccounts,
  mobileAccountSessionStorageKey,
  saveMobileAccountSession,
  type MobileSession,
  type NativeBridge,
  type TauriStoreHandle,
} from "@takosjp/mobile-kit";
import { createFeedRecoveryAccounts } from "../src/feed-recovery.ts";
import { productAdapter } from "../src/product.ts";

type ProductApp = ReturnType<
  typeof import("../src/mobile-app.tsx").createYurucommuMobileApp
>;
let server: ViteDevServer;
let scratch: string;
let createApp: (bridge: () => NativeBridge) => ProductApp;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "yuru-kit-adoption-"));
  // Compile the real product callback with its owning JSX compiler. No UI or
  // native runtime is launched, and no replacement retirement callback is used.
  server = await createServer({
    configFile: false,
    root: new URL("..", import.meta.url).pathname,
    cacheDir: scratch,
    plugins: [solid({ ssr: true })],
    server: { middlewareMode: true, watch: null, hmr: false },
    ssr: { noExternal: ["@takosjp/mobile-kit"] },
  });
  const app = await server.ssrLoadModule("/src/mobile-app.tsx");
  createApp = app.createYurucommuMobileApp;
});
afterAll(async () => {
  await server?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function memoryBridge() {
  const plain = new Map<string, string>();
  const secure = new Map<string, string>();
  let unlocks = 0;
  const bridge: NativeBridge = {
    capabilities: {
      launchPayload: true,
      launchPayloadEvents: false,
      externalBrowser: false,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: true,
      callIntent: false,
      clipboardText: false,
      secureStorage: true,
      persistentStorage: true,
    },
    storage: {
      kind: "device-persistent",
      get: async (key) => plain.get(key),
      set: async (key, value) => { plain.set(key, value); },
      delete: async (key) => { plain.delete(key); },
    },
    secureStore: {
      kind: "secure",
      get: async (key) => secure.get(key),
      set: async (key, value) => { secure.set(key, value); },
      delete: async (key) => { secure.delete(key); },
    },
    getLaunchPayload: async () => undefined,
    openExternalUrl: async () => { throw new Error("unexpected external open"); },
    authenticateBiometric: async () => { unlocks++; return false; },
  };
  return { bridge, secure, unlocks: () => unlocks };
}
const session = (accountId: string): MobileSession => ({
  product: "yurucommu",
  hostUrl: "https://kit-adoption.example",
  accountId,
  accessToken: "synthetic-local-" + accountId,
  tokenType: "Bearer",
  createdAt: "2026-11-17T00:00:00Z",
});
const scope = {
  product: "yurucommu" as const,
  hostUrl: session("A").hostUrl,
  actorApId: "https://kit-adoption.example/ap/users/owner",
};
const draft = (content: string) => ({
  content,
  visibility: "followers" as const,
  attachments: [],
  intent: {
    id: "fixture-unknown-intent",
    phase: "uncertain" as const,
    content: "original result remains unknown",
    visibility: "followers" as const,
    media: [],
  },
});

for (const defect of ["missing", "mismatched"] as const) {
  test(`Kit retirement reaches the product recovery callback for a ${defect} inactive credential`, async () => {
    const { bridge, secure, unlocks } = memoryBridge();
    const input = { adapter: productAdapter, nativeBridge: bridge };
    const a = (await saveMobileAccountSession({ ...input, session: session("A") }))!;
    const b = (await saveMobileAccountSession({ ...input, session: session("B") }))!;
    const saved = createFeedRecoveryAccounts({ store: bridge.secureStore });
    await saved.bind(a, scope).save(draft("A current draft"));
    await saved.bind(b, scope).save(draft("B current draft"));
    const app = createApp(() => bridge);
    let homeReads = 0;
    const controller = createMobileClientController({
      adapter: app.adapter,
      nativeBridge: app.createNativeBridge(),
      sessionUnlock: app.sessionUnlock,
      onAccountScopeRetired: app.onAccountScopeRetired,
      loadHome: async () => { homeReads++; return undefined; },
      fetch: async () => { throw new Error("unexpected auth request"); },
    });
    try {
      await controller.start();
      expect(controller.getState().session).toBeUndefined();
      expect(controller.getState().lockedSession?.accountId).toBe("B");
      expect(unlocks()).toBe(0);
      await controller.unlockSession();
      expect(unlocks()).toBe(1);
      expect(controller.getState().session).toBeUndefined();
      await controller.switchAccount(a.id);
      await controller.switchAccount(b.id);
      await controller.switchAccount("not-a-saved-account");
      const before = createFeedRecoveryAccounts({ store: bridge.secureStore });
      expect(await before.bind(a, scope).load()).toEqual(draft("A current draft"));
      expect(await before.bind(b, scope).load()).toEqual(draft("B current draft"));
      const key = mobileAccountSessionStorageKey(productAdapter, a.id);
      if (defect === "missing") secure.delete(key);
      else secure.set(key, JSON.stringify(session("foreign-subject")));
      await controller.switchAccount(a.id);
      // Kit dispatches cleanup detached from the account operation.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await loadMobileAccounts(input)).accounts.map((row) => row.id)).toEqual([b.id]);
      expect(controller.getState().lockedSession?.accountId).toBe("B");
      expect(controller.getState().session).toBeUndefined();
      expect(homeReads).toBe(0);
      const restarted = createFeedRecoveryAccounts({ store: bridge.secureStore });
      expect(await restarted.bind(a, scope).load()).toBeNull();
      expect(await restarted.bind(b, scope).load()).toEqual(draft("B current draft"));
      expect(await restarted.pendingCleanup(await loadMobileAccounts(input))).toEqual([]);
    } finally {
      controller.stop();
      await app.disposeAndroidBack();
    }
  });
}

function storeHandle(): TauriStoreHandle {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => values.delete(key),
    save: async () => {},
  };
}

test("explicit startup retry reuses the product bridge after native Stronghold initialization rejects", async () => {
  let loads = 0, homes = 0;
  const failure = new Error("synthetic Stronghold initialization failure");
  const handle = storeHandle();
  const bridge = createTauriMobileDefaultProductBridge({
    productAdapter,
    keychainService: "com.yurucommu",
    isTauriRuntime: () => true,
    platform: { platform: () => "android" },
    invoke: async <T>() => "synthetic-existing-vault-password" as T,
    path: { appDataDir: async () => "/synthetic", join: async (...parts) => parts.join("/") },
    deepLink: { getCurrent: async () => null, onOpenUrl: async () => () => {} },
    opener: { openUrl: async () => { throw new Error("unexpected external open"); } },
    store: { load: async () => handle },
    stronghold: { load: async () => {
      if (++loads === 1) throw failure;
      const client = { getStore: () => ({
        get: async () => null,
        insert: async () => {},
        remove: async () => null,
      }) };
      return { loadClient: async () => client, createClient: async () => client, save: async () => {} };
    } },
  });
  const app = createApp(() => bridge);
  const controller = createMobileClientController({
    adapter: app.adapter,
    nativeBridge: app.createNativeBridge(),
    sessionUnlock: app.sessionUnlock,
    onAccountScopeRetired: app.onAccountScopeRetired,
    loadHome: async () => { homes++; return undefined; },
    fetch: async () => { throw new Error("unexpected auth request"); },
  });
  try {
    await expect(controller.start()).rejects.toBe(failure);
    expect(loads).toBe(1);
    expect(controller.getState().session).toBeUndefined();
    expect(controller.getState().status).not.toBe("");
    // No automatic retry: only the user's next explicit start retries init.
    await Promise.resolve();
    expect(loads).toBe(1);
    await controller.start();
    expect(loads).toBe(2);
    expect(app.createNativeBridge()).toBe(bridge);
    expect(await bridge.secureStore!.get("absent")).toBeUndefined();
    expect(loads).toBe(2);
    expect(homes).toBe(0);
    expect(controller.getState().accounts).toEqual([]);
  } finally {
    controller.stop();
    await app.disposeAndroidBack();
  }
});

test("quality and native preflight deliver the same adopted Kit source", async () => {
  const refs = await Promise.all(["ci.yml", "mobile-native-preflight.yml"].map(async (name) => {
    const source = await Bun.file(new URL("../.github/workflows/" + name, import.meta.url)).text();
    return /MOBILE_KIT_SOURCE_REF:\s*([a-f0-9]{40})/.exec(source)?.[1];
  }));
  expect(refs).toEqual([
    "65820519d2e73befa550b96cd974c49b232cc41b",
    "65820519d2e73befa550b96cd974c49b232cc41b",
  ]);
});
