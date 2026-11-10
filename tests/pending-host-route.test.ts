import { expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { pendingHostRouteForSession, type NativeNotificationRouteRequest } from "../src/host-route.ts";

const a: MobileSession = {
  hostUrl: "https://pending-a.example", product: "yurucommu",
  accessToken: "synthetic-local-a", tokenType: "Bearer", createdAt: "2026-11-10T00:00:00.000Z",
};
const request: NativeNotificationRouteRequest = {
  session: a, target: { page: "post", apId: a.hostUrl + "/ap/objects/original" },
};

test("same-session home refresh retains the exact unadopted route", () => {
  expect(pendingHostRouteForSession(request, { ...a })).toBe(request);
  const notifications: NativeNotificationRouteRequest = { session: a, target: { page: "notifications" } };
  expect(pendingHostRouteForSession(notifications, a)).toBe(notifications);
});

test("an empty queue does not acquire a destination on home load", () => {
  expect(pendingHostRouteForSession(undefined, a)).toBeUndefined();
});

for (const [name, fields] of Object.entries({
  host: { hostUrl: "https://pending-b.example" },
  product: { product: "yurume" },
  credential: { accessToken: "synthetic-local-b" },
  tokenType: { tokenType: "other-type" },
  epoch: { createdAt: "2026-11-10T00:01:00.000Z" },
  issuer: { oidcIssuer: "https://issuer.example" },
  client: { oidcClientId: "synthetic-public-client" },
  apiRoot: { apiBaseUrl: a.hostUrl + "/api/other" },
  endpoint: { productEndpoints: { currentUser: "/api/another-me" } },
})) {
  test(`selected ${name} changes retire a pending route before home settles`, () => {
    expect(pendingHostRouteForSession(request, { ...a, ...fields })).toBeUndefined();
  });
}

test("returning to the original stored credentials cannot revive a retired route", () => {
  const b = { ...a, accessToken: "synthetic-local-b" };
  const retired = pendingHostRouteForSession(request, b);
  expect(pendingHostRouteForSession(retired, a)).toBeUndefined();
  const current: NativeNotificationRouteRequest = { ...request, session: b };
  expect(pendingHostRouteForSession(current, b)).toBe(current);
});

test("endpoint ordering alone does not change the pending route's scope", () => {
  const original: NativeNotificationRouteRequest = { ...request,
    session: { ...a, productEndpoints: { currentUser: "/api/auth/me", timeline: "/api/timeline" } } };
  expect(pendingHostRouteForSession(original, {
    ...a, productEndpoints: { timeline: "/api/timeline", currentUser: "/api/auth/me" },
  })).toBe(original);
});
