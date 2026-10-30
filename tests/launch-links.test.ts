import { expect, test } from "bun:test";
import {
  createMobileClientController,
  mobileSessionStorageKey,
  type FetchLike,
  type MobileSession,
  type NativeBridge,
} from "@takosjp/mobile-kit";
import { productAdapter } from "../src/product.ts";
import {
  createHostRouteHandoff,
  hostRouteNoticeFor,
  type HostRouteNotice,
} from "../src/host-route.ts";

// TASK-0119 step 5: what Takosumi sends and what this app does with it.
// Takosumi fills the trusted templates for this app (scheme `yurucommu`,
// package/bundle `com.yurucommu`) with the screen URL's origin, URL-encoded:
//   yurucommu://connect?host_url={origin}
//   yurucommu://connect?host_url={origin}&product=yurucommu
const A = "https://a.social.example";
const B = "https://b.social.example";

function takosumiConnectLink(origin: string, withProduct: boolean): string {
  const link = `yurucommu://connect?host_url=${encodeURIComponent(origin)}`;
  return withProduct ? `${link}&product=yurucommu` : link;
}

test("both Takosumi connect templates find the server and stop before sign-in", async () => {
  for (const withProduct of [false, true]) {
    const { controller } = setup();
    await controller.handleLaunchPayload(takosumiConnectLink(A, withProduct));
    expect(controller.getState().discovery?.hostUrl).toBe(A);
    expect(controller.getState().session).toBeUndefined();
    controller.stop();
  }
});

test("a connect link for another server while signed in asks and keeps the current session", async () => {
  const { controller, bridge } = setup();
  await signIn(controller, A);

  await controller.handleLaunchPayload(takosumiConnectLink(B, true));
  // Nothing switched: A is still in use and B is offered.
  expect(controller.getState().session?.hostUrl).toBe(A);
  expect(controller.getState().session?.accessToken).toBe("a.social.example-session");
  expect(controller.getState().discovery?.hostUrl).toBe(B);

  // Choosing to sign in adds B without losing A.
  await controller.signInWithPassword("pw");
  expect(controller.getState().session?.hostUrl).toBe(B);
  const accountA = controller.getState().accounts.find((a) => a.hostUrl === A)!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.accessToken).toBe("a.social.example-session");
  expect(bridge.opened).toEqual([]);
  controller.stop();
});

test("dismissing the prompt for another server keeps the current session", async () => {
  const { controller } = setup();
  await signIn(controller, A);
  await controller.handleLaunchPayload(takosumiConnectLink(B, false));
  controller.cancelAddAccount();
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().session?.hostUrl).toBe(A);
  controller.stop();
});

test("a connect link for the server in use just opens the app", async () => {
  const { controller, requests } = setup();
  await signIn(controller, A);
  const before = requests.length;
  await controller.handleLaunchPayload(takosumiConnectLink(A, true));
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().session?.hostUrl).toBe(A);
  expect(requests.length).toBe(before);
  controller.stop();
});

test("route links open on the home screen and never in a browser", async () => {
  const { controller, bridge, notices } = setup();
  await signIn(controller, A);

  await controller.handleLaunchPayload(`yurucommu://open?path=%2F&host_url=${encodeURIComponent(A)}`);
  expect(notices.at(-1)).toBeUndefined();
  // A Takosumi screen URL (`{url}`) is the server's own origin.
  await controller.handleLaunchPayload(`yurucommu://open?url=${encodeURIComponent(`${A}/`)}`);
  expect(notices.at(-1)).toBeUndefined();
  await controller.handleLaunchPayload("yurucommu://open?path=%2Fbookmarks");
  expect(notices.at(-1)).toBeUndefined();

  await controller.handleLaunchPayload("yurucommu://open?path=%2Fstories%3Fid%3D1");
  expect(notices.at(-1)).toEqual({ hostUrl: A, path: "/stories" });
  expect(controller.getState().pendingRoute).toBeUndefined();
  expect(bridge.opened).toEqual([]);
  controller.stop();
});

test("a route link waits for sign-in and then opens on that server", async () => {
  const { controller, notices } = setup();
  await controller.handleLaunchPayload(
    `yurucommu://open?path=%2Fnotifications&host_url=${encodeURIComponent(A)}`,
  );
  expect(controller.getState().discovery?.hostUrl).toBe(A);
  expect(notices).toEqual([]);
  await controller.signInWithPassword("pw");
  expect(controller.getState().session?.hostUrl).toBe(A);
  expect(notices.at(-1)).toEqual({ hostUrl: A, path: "/notifications" });
  controller.stop();
});

test("a route link for another saved server asks before switching", async () => {
  const { controller, notices } = setup();
  await signIn(controller, A);
  await controller.handleLaunchPayload(takosumiConnectLink(B, true));
  await controller.signInWithPassword("pw");
  expect(controller.getState().session?.hostUrl).toBe(B);

  await controller.handleLaunchPayload(
    `yurucommu://open?path=%2Fstories&host_url=${encodeURIComponent(A)}`,
  );
  expect(controller.getState().session?.hostUrl).toBe(B);
  expect(controller.getState().discovery?.hostUrl).toBe(A);
  expect(notices).toEqual([]);

  const accountA = controller.getState().accounts.find((a) => a.hostUrl === A)!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.hostUrl).toBe(A);
  expect(notices.at(-1)).toEqual({ hostUrl: A, path: "/stories" });
  controller.stop();
});

test("unsafe route links are refused before anything opens", async () => {
  const { controller, bridge, notices } = setup();
  await signIn(controller, A);
  for (const link of [
    "yurucommu://open?path=%2F%5Cevil.example",
    "yurucommu://open?path=%2F%2Fevil.example",
    "yurucommu://open?url=javascript%3Aalert(1)",
    "yurucommu://open?path=%2Foauth%2Fcallback%3Fcode%3Dattacker",
    "yurucommu://open?path=%2F%23access_token%3Dt",
    `yurucommu://open?path=%2F&host_url=${encodeURIComponent("http://evil.example")}`,
    `yurucommu://open?url=${encodeURIComponent("https://evil.example/x")}&host_url=${encodeURIComponent(A)}`,
  ]) {
    await controller.handleLaunchPayload(link);
    expect(controller.getState().session?.hostUrl, link).toBe(A);
    expect(controller.getState().discovery, link).toBeUndefined();
    expect(controller.getState().pendingRoute, link).toBeUndefined();
  }
  expect(notices).toEqual([]);
  expect(bridge.opened).toEqual([]);
  controller.stop();
});

test("the route handoff refuses a URL on another server", async () => {
  const handoff = createHostRouteHandoff(() => {});
  await expect(
    handoff({ session: session(A), path: "/", url: `${B}/` }),
  ).rejects.toThrow("接続中のサーバーではありません");
});

test("a notice is shown only for the server it came from", () => {
  const notice: HostRouteNotice = { hostUrl: A, path: "/stories" };
  expect(hostRouteNoticeFor(notice, { hostUrl: A })).toBe(notice);
  expect(hostRouteNoticeFor(notice, { hostUrl: B })).toBeUndefined();
});

test("an install from before multi-account keeps its session after the update", async () => {
  const bridge = memoryBridge();
  const { fetch } = familyHosts();
  // The single-session shape and key that earlier releases stored.
  await bridge.secureStore!.set(
    mobileSessionStorageKey(productAdapter),
    JSON.stringify({
      hostUrl: A,
      product: "yurucommu",
      productEndpoints: { mobileLogout: "/api/auth/logout" },
      accessToken: "legacy-host-session",
      tokenType: "Bearer",
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  );
  const homes: string[] = [];
  const loadHome = async (current: MobileSession) => {
    homes.push(current.accessToken);
    return {};
  };
  const first = createMobileClientController({
    adapter: productAdapter, nativeBridge: bridge, fetch, loadHome,
  });
  await first.start();
  expect(first.getState().session?.accessToken).toBe("legacy-host-session");
  expect(first.getState().accounts.map((a) => a.hostUrl)).toEqual([A]);
  first.stop();

  // A second launch reads the migrated account, not the old key.
  const second = createMobileClientController({
    adapter: productAdapter, nativeBridge: bridge, fetch, loadHome,
  });
  await second.start();
  expect(second.getState().session?.accessToken).toBe("legacy-host-session");
  expect(homes).toEqual(["legacy-host-session", "legacy-host-session"]);
  second.stop();
});

function setup() {
  const bridge = memoryBridge();
  const { fetch, requests } = familyHosts();
  const notices: Array<HostRouteNotice | undefined> = [];
  const controller = createMobileClientController({
    adapter: productAdapter,
    nativeBridge: bridge,
    fetch,
    openHostRoute: createHostRouteHandoff((notice) => notices.push(notice)),
  });
  return { controller, bridge, requests, notices };
}

async function signIn(
  controller: ReturnType<typeof createMobileClientController>,
  hostUrl: string,
) {
  await controller.connectWithInput(hostUrl);
  await controller.signInWithPassword("pw");
  expect(controller.getState().session?.hostUrl).toBe(hostUrl);
}

function session(hostUrl: string): MobileSession {
  return {
    hostUrl,
    product: "yurucommu",
    accessToken: "t",
    tokenType: "Bearer",
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}

/** Two Yurucommu servers that each mint their own host session. */
function familyHosts(): { fetch: FetchLike; requests: string[] } {
  const requests: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.pathname === "/.well-known/yurucommu") {
      return Response.json({
        product: "yurucommu",
        auth: { oidc: false, password: true },
        capabilities: ["api.social.v1", "client.yurucommu.feed.v1"],
        endpoints: {
          mobilePasswordLogin: "/api/auth/mobile/login",
          mobileLogout: "/api/auth/logout",
        },
      });
    }
    if (url.pathname === "/api/auth/mobile/login" && init?.method === "POST") {
      return Response.json({
        access_token: `${url.hostname}-session`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, requests };
}

function memoryBridge(): NativeBridge & { readonly opened: string[] } {
  const secure = new Map<string, string>();
  const plain = new Map<string, string>();
  const opened: string[] = [];
  return {
    opened,
    capabilities: {
      launchPayload: true,
      launchPayloadEvents: false,
      externalBrowser: true,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: false,
      callIntent: false,
      clipboardText: false,
      secureStorage: true,
      persistentStorage: true,
    },
    storage: {
      kind: "device-persistent",
      get: async (key) => plain.get(key),
      set: async (key, value) => void plain.set(key, value),
      delete: async (key) => void plain.delete(key),
    },
    secureStore: {
      kind: "secure",
      get: async (key) => secure.get(key),
      set: async (key, value) => void secure.set(key, value),
      delete: async (key) => void secure.delete(key),
    },
    getLaunchPayload: async () => undefined,
    openExternalUrl: async (url) => void opened.push(url),
  };
}
