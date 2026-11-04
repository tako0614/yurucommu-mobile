import {
  batch,
  createRenderEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type JSX,
} from "solid-js";
import type { NativeBridge } from "@takosjp/mobile-kit";
import { confirmMobileAction } from "@takosjp/mobile-kit";
import {
  type MobileClientAppProps,
  type MobileShellHomeExtraContext,
  type MobileShellMetric,
} from "@takosjp/mobile-kit/solid";
import {
  loadHome,
  registerPush,
  unregisterPush,
  type YurucommuMobileHome,
} from "./api.ts";
import { productAdapter } from "./product.ts";
import {
  Feed,
  BookmarksPreview,
  HostRouteNoticeBanner,
} from "./feed-screen.tsx";
import { createFeedHomeLoader } from "./feed-home-loader.ts";
import {
  createHostRouteHandoff,
  type HostRouteNotice,
  type NativeNotificationRouteRequest,
} from "./host-route.ts";
import { createPostLikeStore } from "./post-like-controller.ts";
import { createNotificationController } from "./notification-controller.ts";
import { NotificationScreen } from "./notification-screen.tsx";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

const metrics = [
  { label: "投稿", value: (home) => home?.posts.length },
  { label: "未読", value: (home) => home?.unread },
  { label: "フォロー", value: () => undefined },
] satisfies readonly MobileShellMetric<YurucommuMobileHome>[];

export function createYurucommuMobileApp(
  createNativeBridge: () => NativeBridge,
): MobileClientAppProps<YurucommuMobileHome> {
  const loader = createFeedHomeLoader({ loadHome });
  // Screen links and notification taps stay in this native account.
  // Unsupported routes are reported without opening an unauthenticated browser.
  const [routeNotice, setRouteNotice] = createSignal<HostRouteNotice>();
  const [requestedRoute, setRequestedRoute] =
    createSignal<NativeNotificationRouteRequest>();
  const openHostRoute = createHostRouteHandoff(setRouteNotice, (request) =>
    setRequestedRoute({
      ...request,
      session: snapshotFeedSession(request.session),
    }),
  );
  let view:
    | {
        active: boolean;
        revision: number;
        owner: ReturnType<typeof getOwner>;
        element: JSX.Element;
        dispose: () => void;
        updateActions: (
          context: MobileShellHomeExtraContext<YurucommuMobileHome>,
        ) => void;
      }
    | undefined;

  function renderFeed(
    context: MobileShellHomeExtraContext<YurucommuMobileHome>,
  ) {
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
        active: true,
        revision: 0,
        owner,
        element: undefined as JSX.Element,
        dispose: () => {},
        updateActions: (
          _context: MobileShellHomeExtraContext<YurucommuMobileHome>,
        ) => {},
      };
      current.element = createRoot((dispose) => {
        current.dispose = dispose;
        const [home, setHome] = createSignal(context.home);
        const [session, setSession] = createSignal(context.session);
        const [actions, setActions] = createSignal(context);
        const likes = createPostLikeStore({
          session: context.session,
          isActive: () => current.active,
        });
        createRenderEffect(() => likes.updateSession(session()));
        onCleanup(() => likes.dispose());
        const [notificationRevision, setNotificationRevision] = createSignal(0);
        const [bookmarkRevision, setBookmarkRevision] = createSignal(0);
        const notifications = createNotificationController({
          session: context.session,
          isActive: () => current.active,
          onChange: () => setNotificationRevision((value) => value + 1),
          onBookmarksChanged: () => setBookmarkRevision((value) => value + 1),
          onPostReplied: () => actions().refreshHome(),
          confirmDiscardReply: () =>
            confirmMobileAction({
              message:
                "別の投稿へ移ると、入力中の返信と添付を破棄します。移動しますか？",
            }),
        });
        const notificationState = () => {
          notificationRevision();
          return notifications.getState();
        };
        let homeRoot: HTMLDivElement | undefined;
        let postOrigin:
          | {
              trigger: HTMLButtonElement;
              sessionKey: string;
              id: string;
              surface: string | undefined;
            }
          | undefined;
        const openPost = (id: string, trigger: HTMLButtonElement) => {
          if (!current.active) return;
          postOrigin = {
            trigger,
            sessionKey: feedSessionIdentity(session()),
            id,
            surface: trigger.dataset.postSurface,
          };
          void notifications.openPost(id);
        };
        const homeFocus = (): HTMLElement | undefined => {
          const origin = postOrigin;
          postOrigin = undefined;
          if (
            !origin ||
            !current.active ||
            feedSessionIdentity(session()) !== origin.sessionKey
          )
            return;
          if (origin.trigger.isConnected && !origin.trigger.closest("[hidden]"))
            return origin.trigger;
          // A refresh can replace card nodes while detail is open. Resolve the
          // equivalent card within this view using values, never a dynamic selector.
          return (
            Array.from(
              homeRoot?.querySelectorAll<HTMLButtonElement>(
                "button[data-post-id]",
              ) ?? [],
            ).find(
              (button) =>
                button.dataset.postId === origin.id &&
                button.dataset.postSurface === origin.surface,
            ) ?? homeRoot
          );
        };
        createRenderEffect(() => {
          if (notificationState().page === "notifications")
            postOrigin = undefined;
        });
        let adoptedRoute: NativeNotificationRouteRequest | undefined;
        createRenderEffect(() => {
          const request = requestedRoute();
          if (
            !request ||
            request === adoptedRoute ||
            feedSessionIdentity(request.session) !==
              feedSessionIdentity(session())
          )
            return;
          adoptedRoute = request;
          if (request.target.page === "notifications")
            void notifications.openNotifications();
          else if (request.target.page === "post")
            void notifications.openPost(request.target.apId);
          else notifications.showHome();
        });
        current.updateActions = setActions;
        const release = loader.mount(context, (snapshot) =>
          batch(() => {
            if (
              feedSessionIdentity(snapshot.session) !==
              feedSessionIdentity(session())
            ) {
              postOrigin = undefined;
              if (adoptedRoute && requestedRoute() === adoptedRoute)
                setRequestedRoute(undefined);
              adoptedRoute = undefined;
              notifications.updateSession(snapshot.session);
            }
            setSession(snapshot.session);
            setHome(snapshot.home);
          }),
        );
        onCleanup(release);
        onCleanup(() => {
          notifications.dispose();
          if (adoptedRoute && requestedRoute() === adoptedRoute)
            setRequestedRoute(undefined);
        });
        return (
          <>
            <HostRouteNoticeBanner
              notice={routeNotice()}
              session={session()}
              onDismiss={() => setRouteNotice(undefined)}
            />
            <NotificationScreen
              session={session()}
              state={notificationState()}
              controller={notifications}
              isActive={() => current.active}
              homeFocus={homeFocus}
              likes={likes}
            />
            <div
              ref={homeRoot}
              tabIndex={-1}
              role="region"
              aria-label="フィードと保存した投稿"
              hidden={notificationState().page !== "home"}
            >
              <Feed
                home={home()}
                session={session()}
                refreshHome={() => actions().refreshHome()}
                likes={likes}
                likeActionsActive={() => notificationState().page === "home"}
                isActive={() => current.active}
                onOpenPost={openPost}
              />
              <BookmarksPreview
                likes={likes}
                likeActionsActive={() => notificationState().page === "home"}
                revision={bookmarkRevision()}
                session={session()}
                isActive={() => current.active}
                onOpenPost={openPost}
              />
            </div>
          </>
        );
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
    // The pinned shell screens push targets and sends taps through the same
    // native route handoff as links. No browser receives this app's bearer.
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
    // Product screens below own their host-scoped API requests. No external
    // browser shortcut is offered without an authenticated handoff.
    hostActions: [],
    renderHomeExtra: renderFeed,
  };
}
