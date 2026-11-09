import { expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import type { NativeNotificationRouteRequest } from "../src/host-route.ts";
import { createDeferredHostRoute } from "../src/deferred-host-route.ts";

const a: MobileSession = { product: "yurucommu", hostUrl: "https://a.example", accessToken: "synthetic-a", tokenType: "Bearer", createdAt: "first-login" };
function fixture() {
  let current = a, blocked = false, active = true;
  const opened: NativeNotificationRouteRequest[] = [];
  let notice: NativeNotificationRouteRequest | undefined;
  const routes = createDeferredHostRoute({ session: () => current, isActive: () => active, isBlocked: () => blocked, open: request => opened.push(request), onChange: request => { notice = request; } });
  return { routes, opened, notice: () => notice, block: (value: boolean) => { blocked = value; }, session: (value: MobileSession) => { current = value; }, retire: () => { active = false; } };
}
const request = (page: "home" | "notifications" = "notifications"): NativeNotificationRouteRequest => ({ session: a, target: { page } });

test("an editor defers the original link until a separate explicit retry after closing", () => {
  const f = fixture(), original = request();f.block(true);
  expect(f.routes.receive(original)).toBe(false);
  expect(f.opened).toEqual([]);expect(f.notice()).toBe(original);
  expect(f.routes.retry()).toBe(false);expect(f.opened).toEqual([]);
  f.block(false);expect(f.opened).toEqual([]);
  expect(f.routes.retry()).toBe(true);expect(f.opened).toEqual([original]);expect(f.notice()).toBeUndefined();
  expect(f.routes.retry()).toBe(false);expect(f.opened).toEqual([original]);
});

test("the latest explicit link replaces a deferred destination without replaying the older one", () => {
  const f = fixture(), first = request(), second = request("home");f.block(true);
  f.routes.receive(first);f.routes.receive(second);expect(f.notice()).toBe(second);
  f.block(false);f.routes.retry();expect(f.opened).toEqual([second]);
  f.block(true);f.routes.receive(first);f.block(false);f.routes.receive(second);
  expect(f.routes.retry()).toBe(false);expect(f.opened).toEqual([second, second]);
});

for (const change of ["account", "login", "host", "inactive", "dispose"] as const) {
  test(`a deferred route cannot reopen after ${change} retirement`, () => {
    const f = fixture(), original = request();f.block(true);f.routes.receive(original);f.block(false);
    if (change === "account") f.session({ ...a, accessToken: "synthetic-b" });
    if (change === "login") f.session({ ...a, createdAt: "next-login" });
    if (change === "host") f.session({ ...a, hostUrl: "https://b.example" });
    if (change === "inactive") f.retire();
    if (change === "dispose") f.routes.dispose();
    expect(f.routes.retry()).toBe(false);expect(f.opened).toEqual([]);expect(f.notice()).toBeUndefined();
    expect(f.routes.receive(original)).toBe(false);expect(f.opened).toEqual([]);
  });
}

test("a route for another scope cannot replace the pending destination or open", () => {
  const f = fixture(), original = request();f.block(true);f.routes.receive(original);
  expect(f.routes.receive({ ...original, session: { ...a, accessToken: "synthetic-b" } })).toBe(false);
  expect(f.notice()).toBe(original);expect(f.opened).toEqual([]);
  f.routes.clear();f.block(false);expect(f.routes.retry()).toBe(false);
  expect(f.routes.receive(original)).toBe(true);expect(f.opened).toEqual([original]);
});
