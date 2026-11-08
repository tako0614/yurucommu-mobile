import { expect, test } from "bun:test";
import {
  createAndroidBackNavigation,
  createBackActionSlot,
  type AndroidBackFailure,
  type AndroidBackRelease,
  type AndroidBackTarget,
} from "../src/android-back-navigation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => Bun.sleep(0);
test("a retired screen cannot clear its replacement's Back action", () => {
  const slot = createBackActionSlot();
  const visited: string[] = [];
  const first = slot.register(() => { visited.push("old"); });
  const second = slot.register(() => { visited.push("new"); });
  first(); slot.run();
  expect(visited).toEqual(["new"]);
  second(); slot.run();
  expect(visited).toEqual(["new"]);
});
function fixture() {
  const entries: { press: () => void; active: boolean }[] = [];
  const failures: (AndroidBackFailure | undefined)[] = [];
  const navigation = createAndroidBackNavigation({
    async register(press) {
      const entry = { press, active: true };
      entries.push(entry);
      return async () => { entry.active = false; };
    },
    onFailure: (failure) => { failures.push(failure); },
  });
  const owner = {};
  const target = (back: AndroidBackTarget["back"], scope = "account-A") =>
    ({ owner, scope, back, isActive: () => true });
  return { navigation, entries, failures, owner, target };
}

test("root has no listener and closing its only surface restores zero listeners", async () => {
  const f = fixture();
  expect(f.entries).toHaveLength(0);
  let backs = 0;
  await f.navigation.setTarget(f.target(() => { backs++; }));
  expect(f.entries.filter((entry) => entry.active)).toHaveLength(1);
  f.entries[0]!.press();
  await tick();
  expect(backs).toBe(1);
  await f.navigation.clear(f.owner);
  expect(f.entries.filter((entry) => entry.active)).toHaveLength(0);
  f.entries[0]!.press();
  await tick();
  expect(backs).toBe(1);
});

test("a same-account render update cannot consume a queued Back", async () => {
  const f = fixture();
  let backs = 0;
  await f.navigation.setTarget(f.target(() => { backs++; }));
  f.entries[0]!.press();
  await f.navigation.setTarget(f.target(() => { backs++; }));
  await tick();
  expect(backs).toBe(1);
  expect(f.entries).toHaveLength(1);
  await f.navigation.dispose();
});

test("late registration after close is removed without accepting its callback", async () => {
  const ready = deferred<AndroidBackRelease>();
  let press: (() => void) | undefined, removed = 0, backs = 0;
  const navigation = createAndroidBackNavigation({
    register: async (handler) => { press = handler; return ready.promise; },
    onFailure() {},
  });
  const owner = {};
  const opening = navigation.setTarget({ owner, scope: "A", isActive: () => true, back: () => { backs++; } });
  await tick();
  const closing = navigation.clear(owner);
  press?.();
  ready.resolve(async () => { removed++; });
  await opening;
  await closing;
  press?.();
  await tick();
  expect(removed).toBe(1);
  expect(backs).toBe(0);
});

test("A to B to A cannot revive either retired callback", async () => {
  const f = fixture();
  const visited: string[] = [];
  await f.navigation.setTarget(f.target(() => { visited.push("old-A"); }));
  await f.navigation.setTarget(f.target(() => { visited.push("B"); }, "account-B"));
  await f.navigation.setTarget(f.target(() => { visited.push("new-A"); }));
  for (const entry of f.entries) entry.press();
  await tick();
  expect(visited).toEqual(["new-A"]);
  expect(f.entries.filter((entry) => entry.active)).toHaveLength(1);
  await f.navigation.dispose();
});

test("cleanup from an old view cannot clear the new view's handler", async () => {
  const f = fixture();
  const other = {}, visited: string[] = [];
  await f.navigation.setTarget(f.target(() => { visited.push("old"); }));
  await f.navigation.setTarget({ owner: other, scope: "account-A", isActive: () => true, back: () => { visited.push("new"); } });
  await f.navigation.clear(f.owner);
  f.entries[0]!.press();
  f.entries[1]!.press();
  await tick();
  expect(visited).toEqual(["new"]);
  await f.navigation.dispose();
});

test("one pending navigation consumes repeated taps but a new scope is independent", async () => {
  const f = fixture();
  const ready = deferred<void>();
  let a = 0, b = 0;
  await f.navigation.setTarget(f.target(async () => { a++; await ready.promise; }));
  f.entries[0]!.press(); f.entries[0]!.press();
  await tick();
  expect(a).toBe(1);
  await f.navigation.setTarget(f.target(() => { b++; }, "account-B"));
  f.entries[1]!.press();
  await tick();
  expect(b).toBe(1);
  ready.resolve(); await tick();
  await f.navigation.dispose();
});

test("failed removal retains its handle and reports failure until explicit retry", async () => {
  let press: (() => void) | undefined, removes = 0, active = false, backs = 0;
  const failures: (AndroidBackFailure | undefined)[] = [];
  const navigation = createAndroidBackNavigation({
    async register(handler) {
      press = handler; active = true;
      return async () => { if (++removes === 1) throw Error("native remove failed"); active = false; };
    },
    onFailure: (failure) => { failures.push(failure); },
  });
  const owner = {};
  await navigation.setTarget({ owner, scope: "A", isActive: () => true, back: () => { backs++; } });
  await navigation.clear(owner);
  expect(active).toBe(true); // Default native Back is not proven restored.
  expect(failures.at(-1)).toBe("remove");
  press?.(); await tick(); expect(backs).toBe(0);
  expect(removes).toBe(1);
  await navigation.retry();
  expect(active).toBe(false);
  expect(removes).toBe(2);
  expect(failures.at(-1)).toBeUndefined();
});

test("failed registration does not loop or silently replace a listener", async () => {
  let attempts = 0;
  const failures: (AndroidBackFailure | undefined)[] = [];
  const navigation = createAndroidBackNavigation({
    async register() { if (++attempts === 1) throw Error("native registration failed"); return async () => {}; },
    onFailure: (failure) => { failures.push(failure); },
  });
  const target = { owner: {}, scope: "A", isActive: () => true, back() {} };
  await navigation.setTarget(target);
  await navigation.setTarget({ ...target });
  expect(attempts).toBe(1);
  expect(failures.at(-1)).toBe("register");
  await navigation.retry();
  expect(attempts).toBe(2);
  expect(failures.at(-1)).toBeUndefined();
  await navigation.dispose();
});

test("disposal during registration fences the callback and releases the late handle", async () => {
  const ready = deferred<AndroidBackRelease>();
  let press: (() => void) | undefined, removes = 0, backs = 0;
  const navigation = createAndroidBackNavigation({
    async register(handler) { press = handler; return ready.promise; }, onFailure() {},
  });
  const opening = navigation.setTarget({ owner: {}, scope: "A", isActive: () => true, back: () => { backs++; } });
  await tick();
  const closing = navigation.dispose();
  ready.resolve(async () => { removes++; });
  await opening; await closing;
  press?.(); await tick();
  expect(removes).toBe(1);
  expect(backs).toBe(0);
});

test("non-Android registration can explicitly decline without a live lease", async () => {
  let attempts = 0;
  const navigation = createAndroidBackNavigation({ async register() { attempts++; return undefined; }, onFailure() {} });
  const target = { owner: {}, scope: "A", isActive: () => true, back() { throw Error("must not run"); } };
  await navigation.setTarget(target);
  await navigation.setTarget({ ...target });
  expect(attempts).toBe(1);
  await navigation.dispose();
});

test("a new account waits for native removal before registering", async () => {
  const removed = deferred<void>();
  const handlers: (() => void)[] = [], visits: string[] = [];
  const navigation = createAndroidBackNavigation({
    async register(handler) { handlers.push(handler); return async () => { if (handlers.length === 1) await removed.promise; }; },
    onFailure() {},
  });
  const owner = {};
  await navigation.setTarget({ owner, scope: "A", isActive: () => true, back: () => { visits.push("A"); } });
  const switching = navigation.setTarget({ owner, scope: "B", isActive: () => true, back: () => { visits.push("B"); } });
  await tick();
  handlers[0]!(); await tick();
  expect(handlers).toHaveLength(1);
  expect(visits).toEqual([]);
  removed.resolve(); await switching;
  expect(handlers).toHaveLength(2);
  handlers[1]!(); await tick();
  expect(visits).toEqual(["B"]);
  await navigation.dispose();
});

test("a temporarily inactive view cannot consume a native callback", async () => {
  const f = fixture();
  let active = true, backs = 0;
  await f.navigation.setTarget({ ...f.target(() => { backs++; }), isActive: () => active });
  active = false; f.entries[0]!.press(); await tick();
  expect(backs).toBe(0);
  active = true; f.entries[0]!.press(); await tick();
  expect(backs).toBe(1);
  await f.navigation.dispose();
});
