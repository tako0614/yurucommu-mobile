import { batch, createRoot, createSignal, getOwner, onCleanup, type JSX } from "solid-js";
import type { NativeBridge } from "@takosjp/mobile-kit";
import {
  type MobileClientAppProps,
  type MobileShellHomeExtraContext, type MobileShellMetric,
} from "@takosjp/mobile-kit/solid";
import { loadHome, registerPush, unregisterPush, type YurucommuMobileHome } from "./api.ts";
import { productAdapter } from "./product.ts";
import { Feed, BookmarksPreview, HostRouteNoticeBanner } from "./feed-screen.tsx";
import { createFeedHomeLoader } from "./feed-home-loader.ts";
import { createHostRouteHandoff, type HostRouteNotice } from "./host-route.ts";

const metrics = [
  { label: "投稿", value: (home) => home?.posts.length },
  { label: "未読", value: (home) => home?.unread },
  { label: "フォロー", value: () => undefined },
] satisfies readonly MobileShellMetric<YurucommuMobileHome>[];

export function createYurucommuMobileApp(
  createNativeBridge: () => NativeBridge,
): MobileClientAppProps<YurucommuMobileHome> {
  const loader = createFeedHomeLoader({ loadHome });
  // Route links (`yurucommu://open?path=…` / `?url=…`) open on the home screen;
  // a route without a native screen is reported here instead of a browser.
  const [routeNotice, setRouteNotice] = createSignal<HostRouteNotice>();
  const openHostRoute = createHostRouteHandoff(setRouteNotice);
  let view: {
    active: boolean;
    revision: number;
    owner: ReturnType<typeof getOwner>;
    element: JSX.Element;
    dispose: () => void;
    updateActions: (context: MobileShellHomeExtraContext<YurucommuMobileHome>) => void;
  } | undefined;

  function renderFeed(context: MobileShellHomeExtraContext<YurucommuMobileHome>) {
    // The public shell reevaluates this extension in a reactive insertion.
    // Its insertion owner identifies a live sign-in, even for repeated credentials.
    const owner = getOwner();
    if (!owner) throw new Error("フィード画面の表示先を確認できませんでした。");
    if (view && view.owner !== owner) {
      view.active = false;
      view.dispose();
      view = undefined;
    }
    if (!view) {
      const current = {
        active: true, revision: 0, owner,
        element: undefined as JSX.Element,
        dispose: () => {},
        updateActions: (_context: MobileShellHomeExtraContext<YurucommuMobileHome>) => {},
      };
      current.element = createRoot((dispose) => {
        current.dispose = dispose;
        const [home, setHome] = createSignal(context.home);
        const [session, setSession] = createSignal(context.session);
        const [actions, setActions] = createSignal(context);
        current.updateActions = setActions;
        const release = loader.mount(context, (snapshot) => batch(() => {
          setSession(snapshot.session);
          setHome(snapshot.home);
        }));
        onCleanup(release);
        return <>
          <HostRouteNoticeBanner
            notice={routeNotice()}
            session={session()}
            onDismiss={() => setRouteNotice(undefined)}
          />
          <Feed
            home={home()}
            session={session()}
            refreshHome={() => actions().refreshHome()}
            isActive={() => current.active}
          />
          <BookmarksPreview session={session()} isActive={() => current.active} />
        </>;
      }, null);
      view = current;
    }
    const current = view;
    current.active = true;
    current.updateActions(context);
    const revision = ++current.revision;
    onCleanup(() => {
      // Fence outcomes now; only a synchronous rerender may reuse this root.
      current.active = false;
      queueMicrotask(() => {
        if (current.active || current.revision !== revision) return;
        current.dispose();
        if (view === current) view = undefined;
      });
    });
    return current.element;
  }

  return {
    adapter: productAdapter,
    createNativeBridge,
    loadHome: loader.load,
    registerPush,
    unregisterPush,
    openHostRoute,
    // A tapped notification opens the app on the feed, as before. Its targets
    // (notifications, posts) have no native screen yet, so it does not go
    // through the host route handoff.
    handlePushNotification: (input) => input.kind === "tapped",
    sessionUnlock: {
      restoreMode: "if-available",
      prompt: {
        title: "Yurucommu",
        message: "セッションを開きます",
        allowDeviceCredential: true,
      },
    },
    homeLabel: "フィード",
    copy: {
      eyebrow: "YOUR PLACE, YOUR PEOPLE",
      // Mirror of `yurucommu/public/icons/yurucommu.svg`, the product-owned
      // canonical mark. `brandMark` stays as the fallback glyph.
      brandLogoUrl: "/brand/yurucommu.svg",
      brandMark: "ゆ",
      onboardingTitle: "あなたの居場所につながろう",
      summary: "自分のサーバーで、みんなとゆるくつながる。",
      // Mirror of takosumi/dashboard/public/tako.png, the canonical Takosumi
      // mark named by docs/reference/design-language.md, instead of a "T".
      hostCenterIconUrl: "/brand/takosumi.png",
      takosumiActionLabel: "Takosumiで始める",
      takosumiActionDescription: "Takosumiで自分用に作ったサーバーに接続",
      manualActionLabel: "サーバーを自分で入力",
      manualActionDescription: "CloudflareやセルフホストのURLを使用",
      connectLabel: "サーバーURL",
      qrActionLabel: "接続QRを読み取る",
      discoveredHeading: "サーバーが見つかりました",
      homeFallbackTitle: "フィード",
      refreshLabel: "更新",
      homeTitle: (home) => home?.actor.name ?? home?.actor.preferred_username,
      metricsLabel: "フィード概要",
      shortcutsLabel: "メニュー",
    },
    metrics,
    // The feed and saved posts are native below. Stories, notifications and
    // profiles are host web screens, and an external browser would not carry
    // this app's host session (no authenticated browser handoff yet).
    hostActions: [],
    renderHomeExtra: renderFeed,
  };
}
