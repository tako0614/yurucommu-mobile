import { expect, test } from "bun:test";
import {
  beginMobileOidcSignIn,
  completeMobileOidcSignIn,
  loadMobileSession,
  mobileAuthRequestStorageKey,
  signInWithMobilePassword,
  type FetchLike,
  type NativeBridge,
} from "@takosjp/mobile-kit";
import { productAdapter } from "../src/product.ts";

test("Yurucommu exchanges a password only with its connected host", async () => {
  const bridge = memoryBridge();
  const session = await signInWithMobilePassword({
    adapter: productAdapter,
    discovery: {
      hostUrl: "https://social.example",
      authMethods: { oidc: false, password: true },
      product: {
        product: "yurucommu",
        endpoints: {
          mobilePasswordLogin: "/api/auth/mobile/login",
          mobileLogout: "/api/auth/logout",
        },
      },
    },
    nativeBridge: bridge,
    password: " host password ",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://social.example/api/auth/mobile/login");
      expect(await new Response(init?.body).json()).toEqual({
        password: " host password ",
      });
      return Response.json({
        access_token: "password-host-session",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  });
  expect(session.product).toBe("yurucommu");
  expect(session.productEndpoints?.mobileLogout).toBe("/api/auth/logout");
  expect((await loadMobileSession({ adapter: productAdapter, nativeBridge: bridge }))?.accessToken).toBe(
    "password-host-session",
  );
});

test("Yurucommu completes OIDC PKCE and exchanges the ID token for a host session", async () => {
  const bridge = memoryBridge();
  const fetcher = oidcHostFetch("yurucommu");
  const started = await beginMobileOidcSignIn({
    adapter: productAdapter,
    discovery: {
      hostUrl: "https://social.example",
      oidcIssuer: "https://accounts.example",
      oidcClientId: "yurucommu-mobile",
      authMethods: { oidc: true, password: true },
      product: {
        product: "yurucommu",
        endpoints: {
          mobileOidcExchange: "/api/auth/mobile/oidc",
          mobileLogout: "/api/auth/logout",
        },
      },
    },
    nativeBridge: bridge,
    fetch: fetcher,
  });
  expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
    "yurucommu-mobile",
  );
  expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
    "yurucommu://oauth/callback",
  );
  const pending = JSON.parse(
    (await bridge.secureStore?.get(mobileAuthRequestStorageKey(productAdapter))) ?? "",
  ) as { state: string };
  const session = await completeMobileOidcSignIn({
    adapter: productAdapter,
    nativeBridge: bridge,
    callbackUrl: `yurucommu://oauth/callback?code=code-1&state=${pending.state}`,
    fetch: fetcher,
  });
  expect(session.product).toBe("yurucommu");
  expect(session.accessToken).toBe("oidc-host-session");
  expect(session.productEndpoints?.mobileLogout).toBe("/api/auth/logout");
});

function oidcHostFetch(product: "yurucommu"): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url === "https://accounts.example/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.example",
        authorization_endpoint: "https://accounts.example/oauth/authorize",
        token_endpoint: "https://accounts.example/oauth/token",
      });
    }
    if (url === "https://accounts.example/oauth/token") {
      const body = String(init?.body ?? "");
      expect(body).toContain("client_id=yurucommu-mobile");
      expect(body).toContain("code_verifier=");
      return Response.json({
        access_token: "provider-access",
        token_type: "Bearer",
        id_token: "verified-id-token",
      });
    }
    if (url === "https://social.example/api/auth/mobile/oidc") {
      expect(await new Response(init?.body).json()).toEqual({
        id_token: "verified-id-token",
      });
      return Response.json({
        access_token: "oidc-host-session",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected ${product} auth request: ${url}`);
  };
}

function memoryBridge(): NativeBridge {
  const values = new Map<string, string>();
  return {
    capabilities: {
      launchPayload: false,
      launchPayloadEvents: false,
      externalBrowser: false,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: false,
      callIntent: false,
      clipboardText: false,
      secureStorage: true,
      persistentStorage: false,
    },
    secureStore: {
      kind: "secure",
      get: async (key) => values.get(key),
      set: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    },
    getLaunchPayload: async () => undefined,
    openExternalUrl: async () => undefined,
  };
}
