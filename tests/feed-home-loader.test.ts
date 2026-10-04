import { expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import type { YurucommuMobileHome } from "../src/api.ts";
import { createFeedHomeLoader } from "../src/feed-home-loader.ts";

const session: MobileSession = {
  hostUrl: "https://social.example",
  product: "yurucommu",
  accessToken: "token-one",
  tokenType: "Bearer",
  createdAt: "2026-10-04T00:00:00.000Z",
  productEndpoints: undefined,
};

function home(name: string): YurucommuMobileHome {
  return {
    actor: {
      ap_id: `https://social.example/ap/users/${name.toLowerCase()}`,
      preferred_username: name.toLowerCase(),
      name,
      icon_url: null,
    },
    posts: [],
    unread: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

async function microtask() {
  await Promise.resolve();
}

test("mount before the initial load receives the loaded feed snapshot", async () => {
  const request = deferred<YurucommuMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  const loader = createFeedHomeLoader({ loadHome: () => request.promise });
  const release = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));

  const loading = loader.load(session);
  expect(snapshots.at(-1)).toEqual({ session, home: undefined });
  await microtask();
  request.resolve(home("Loaded"));
  await expect(loading).resolves.toEqual(home("Loaded"));
  expect(snapshots.at(-1)).toEqual({ session, home: home("Loaded") });
  release();
});

test("a pre-mount home request is adopted by the matching mount", async () => {
  const request = deferred<YurucommuMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  const loader = createFeedHomeLoader({ loadHome: () => request.promise });
  const loading = loader.load(session);
  await microtask();
  const release = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));
  expect(snapshots.at(-1)).toEqual({ session, home: undefined });

  request.resolve(home("Adopted"));
  await loading;
  expect(snapshots.at(-1)).toEqual({ session, home: home("Adopted") });
  release();
});

test("overlapping refreshes are serialized and every caller gets the latest home", async () => {
  const requests: Array<Deferred<YurucommuMobileHome>> = [];
  const secondStarted = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  const loader = createFeedHomeLoader({
    loadHome: () => {
      const request = deferred<YurucommuMobileHome>();
      requests.push(request);
      if (requests.length === 2) secondStarted.resolve(undefined);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return request.promise.finally(() => { active -= 1; });
    },
  });
  const release = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));

  const firstCaller = loader.load(session);
  await microtask();
  const secondCaller = loader.load(session);
  expect(secondCaller).toBe(firstCaller);
  expect(requests).toHaveLength(1);
  requests[0]!.resolve(home("Stale"));
  await secondStarted.promise;
  expect(maximumActive).toBe(1);
  requests[1]!.resolve(home("Latest"));

  const [firstResult, secondResult] = await Promise.all([firstCaller, secondCaller]);
  expect(firstResult).toEqual(home("Latest"));
  expect(secondResult).toEqual(home("Latest"));
  expect(snapshots.at(-1)).toEqual({ session, home: home("Latest") });
  expect(snapshots.some((snapshot) => snapshot.home?.actor.name === "Stale")).toBe(false);
  release();
});

test("session rotation clears the prior home immediately and retries with current credentials", async () => {
  const oldRequest = deferred<YurucommuMobileHome>();
  const newRequest = deferred<YurucommuMobileHome>();
  const newStarted = deferred<void>();
  const requests: string[] = [];
  const nextSession = { ...session, accessToken: "token-two" };
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  const loader = createFeedHomeLoader({
    loadHome: (current) => {
      requests.push(current.accessToken);
      if (current.accessToken === "token-two") {
        newStarted.resolve(undefined);
        return newRequest.promise;
      }
      return oldRequest.promise;
    },
  });
  const release = loader.mount({ session, home: home("Prior home") }, (snapshot) => snapshots.push(snapshot));
  const staleCaller = loader.load(session);
  await microtask();
  const currentCaller = loader.load(nextSession);
  expect(snapshots.at(-1)).toEqual({ session: nextSession, home: undefined });

  oldRequest.resolve(home("Old token response"));
  await newStarted.promise;
  expect(requests).toEqual(["token-one", "token-two"]);
  newRequest.resolve(home("Current token response"));
  await expect(staleCaller).resolves.toEqual(home("Current token response"));
  await expect(currentCaller).resolves.toEqual(home("Current token response"));
  expect(snapshots.at(-1)).toEqual({ session: nextSession, home: home("Current token response") });
  expect(snapshots.some((snapshot) => snapshot.home?.actor.name === "Old token response")).toBe(false);
  release();
});

test("same-session remount ignores an old successful response from the released lifetime", async () => {
  const oldRequest = deferred<YurucommuMobileHome>();
  const newRequest = deferred<YurucommuMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  let requestNumber = 0;
  const loader = createFeedHomeLoader({
    loadHome: () => (++requestNumber === 1 ? oldRequest.promise : newRequest.promise),
  });
  const releaseOld = loader.mount({ session }, () => {});
  const oldCaller = loader.load(session);
  await microtask();
  releaseOld();

  const releaseCurrent = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));
  const currentCaller = loader.load(session);
  await microtask();
  const publicationsBeforeOldSuccess = snapshots.length;
  oldRequest.resolve(home("Old lifetime"));
  await expect(oldCaller).rejects.toThrow();
  expect(snapshots).toHaveLength(publicationsBeforeOldSuccess);

  newRequest.resolve(home("Current lifetime"));
  await expect(currentCaller).resolves.toEqual(home("Current lifetime"));
  expect(snapshots.at(-1)).toEqual({ session, home: home("Current lifetime") });
  releaseCurrent();
});

test("same-session remount ignores an old failure without clearing its current home", async () => {
  const oldRequest = deferred<YurucommuMobileHome>();
  const newRequest = deferred<YurucommuMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  let requestNumber = 0;
  const loader = createFeedHomeLoader({
    loadHome: () => (++requestNumber === 1 ? oldRequest.promise : newRequest.promise),
  });
  const releaseOld = loader.mount({ session }, () => {});
  const oldCaller = loader.load(session);
  await microtask();
  releaseOld();
  const releaseCurrent = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));
  const currentCaller = loader.load(session);
  await microtask();

  newRequest.resolve(home("Current home"));
  await currentCaller;
  const publicationsAfterCurrentHome = snapshots.length;
  oldRequest.reject(new Error("released request failed"));
  await expect(oldCaller).rejects.toThrow("released request failed");
  expect(snapshots).toHaveLength(publicationsAfterCurrentHome);
  expect(snapshots.at(-1)).toEqual({ session, home: home("Current home") });
  releaseCurrent();
});

test("a current home failure clears the previously loaded feed", async () => {
  const request = deferred<YurucommuMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurucommuMobileHome }> = [];
  const loader = createFeedHomeLoader({ loadHome: () => request.promise });
  const release = loader.mount({ session, home: home("Previously loaded") }, (snapshot) => snapshots.push(snapshot));
  const loading = loader.load(session);
  await microtask();
  request.reject(new Error("timeline unavailable"));

  await expect(loading).rejects.toThrow("timeline unavailable");
  expect(snapshots.at(-1)).toEqual({ session, home: undefined });
  release();
});
