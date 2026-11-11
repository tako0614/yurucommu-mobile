import {
  batch,
  createRenderEffect,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import type { NativeBridge } from "@takosjp/mobile-kit";
import { confirmMobileAction, loadMobileAccounts, mobileAccountIdentity, normalizeHostUrl, type MobileRetiredAccountScope } from "@takosjp/mobile-kit";
import { createFeedRecoveryAccounts, type FeedRecoveryPort } from "./feed-recovery.ts";
import {
  MobileClientApp,
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
  pendingHostRouteForSession,
  type HostRouteNotice,
  type NativeNotificationRouteRequest,
} from "./host-route.ts";
import { createProfileController } from "./profile-controller.ts";
import { createProfileRecoveryStore, type ProfileRecoveryPort } from "./profile-recovery.ts";
import { createPostEditStore } from "./post-edit-store.ts";
import { ProfileScreen } from "./profile-screen.tsx";
import { createPostLikeStore } from "./post-like-controller.ts";
import { createNotificationController } from "./notification-controller.ts";
import { NotificationScreen } from "./notification-screen.tsx";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import { createSearchController } from "./search-controller.ts";
import { SearchScreen } from "./search-screen.tsx";
import {
  createAndroidBackNavigation,
  createBackActionSlot,
  type AndroidBackFailure,
  type AndroidBackRegistrar,
} from "./android-back-navigation.ts";
import { createDeferredHostRoute } from "./deferred-host-route.ts";

const metrics = [
  { label: "投稿", value: (home) => home?.posts.length },
  { label: "未読", value: (home) => home?.unread },
  {
    label: "フォロー",
    value: (home) => {
      const count = home?.actor.following_count;
      return typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
        ? count
        : undefined;
    },
  },
] satisfies readonly MobileShellMetric<YurucommuMobileHome>[];

export function YurucommuMobileApp(props: {
  createNativeBridge: () => NativeBridge;
  registerAndroidBack?: AndroidBackRegistrar;
}) {
  const app = createYurucommuMobileApp(props.createNativeBridge, props.registerAndroidBack);
  onCleanup(() => { void app.disposeAndroidBack(); });
  return <><app.BackRecovery /><MobileClientApp {...app} /></>;
}

export function createYurucommuMobileApp(
  createNativeBridge: () => NativeBridge,
  registerAndroidBack?: AndroidBackRegistrar,
): MobileClientAppProps<YurucommuMobileHome> & {
  BackRecovery: () => JSX.Element;
  disposeAndroidBack: () => Promise<void>;
} {
  let bridge: NativeBridge | undefined;
  const sharedBridge = () => bridge ??= createNativeBridge();
  let recoveryAccounts: ReturnType<typeof createFeedRecoveryAccounts> | undefined;
  const recovery = () => recoveryAccounts ??= createFeedRecoveryAccounts({ store: sharedBridge().secureStore });
  type CleanupAccount = Pick<MobileRetiredAccountScope, "id" | "hostUrl" | "product">;
  const [cleanupFailures, setCleanupFailures] = createSignal<readonly CleanupAccount[]>([]);
  const [cleanupCheckError, setCleanupCheckError] = createSignal(false);
  const [cleaning, setCleaning] = createSignal(false);
  const cleanupKey = (row: CleanupAccount) => JSON.stringify([row.product, normalizeHostUrl(row.hostUrl), row.id]);
  async function cleanupScope(scope: CleanupAccount) {
    try {
      await recovery().retire(scope);
      setCleanupFailures(rows => rows.filter(row => cleanupKey(row) !== cleanupKey(scope)));
    } catch {
      setCleanupFailures(rows => rows.some(row => cleanupKey(row) === cleanupKey(scope)) ? rows : [...rows, scope]);
      throw new Error("サインアウトしましたが、このアカウントの投稿・返信・プロフィール入力の削除を確認できませんでした。");
    }
  }
  async function restoreCleanup() {
    if (!sharedBridge().secureStore) return true;
    try {
      const saved = await loadMobileAccounts({ adapter: productAdapter, nativeBridge: sharedBridge() });
      const pending = await recovery().pendingCleanup(saved);
      const present = new Set(saved.accounts.map(cleanupKey));
      setCleanupFailures(previous => [...new Map([...previous, ...pending]
        .filter(row => !present.has(cleanupKey(row))).map(row => [cleanupKey(row), row])).values()]);
      setCleanupCheckError(false);
      return true;
    } catch { setCleanupCheckError(true); return false; }
  }
  onMount(() => { void restoreCleanup(); });
  async function retryCleanup() {
    if (cleaning()) return;
    setCleaning(true);
    try {
      if (!await restoreCleanup()) return;
      for (const scope of cleanupFailures()) { try { await cleanupScope(scope); } catch { /* The exact row remains retryable. */ } }
    }
    finally { setCleaning(false); }
  }
  const loader = createFeedHomeLoader({ loadHome });
  const [backFailure, setBackFailure] = createSignal<AndroidBackFailure>();
  const androidBack = registerAndroidBack
    ? createAndroidBackNavigation({ register: registerAndroidBack, onFailure: setBackFailure })
    : undefined;
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
        const deletedPostIds = new Set<string>();
        const projectHomePosts = (posts: Readonly<YurucommuMobileHome["posts"]>) =>
          posts.filter((post) => !deletedPostIds.has(post.ap_id)).map((post) => edits.project(post));
        const withoutDeletedPosts = (value: YurucommuMobileHome | undefined) =>
          value ? { ...value, posts: projectHomePosts(value.posts) } : value;
        const forgetHomePost = (id: string) => {
          deletedPostIds.add(id);
          setHome((value) => withoutDeletedPosts(value));
          search.applyPostEdits();
        };
        const [session, setSession] = createSignal(context.session);
        const [actions, setActions] = createSignal(context);
        const [binding, setBinding] = createSignal<{ key: string; port: FeedRecoveryPort;
          reply: (id: string, view: "post" | "profile") => FeedRecoveryPort; profile: () => ProfileRecoveryPort }>();
        const [bindingError, setBindingError] = createSignal("");
        const [bindingRetry, setBindingRetry] = createSignal(0);
        let bindingEpoch = 0, selectedIdentity = "", selectedActor: string | undefined;
        createEffect(() => {
          bindingRetry();
          const currentSession = session(), currentHome = home(), identity = feedSessionIdentity(currentSession);
          const actor = currentHome?.actor.ap_id;
          if (identity !== selectedIdentity || (actor !== undefined && actor !== selectedActor)) {
            selectedIdentity = identity; selectedActor = actor; setBinding(undefined);
          }
          const epoch = ++bindingEpoch; if (!actor) return;
          let live = true; onCleanup(() => { live = false; });
          void (async () => {
            try {
              const accounts = await loadMobileAccounts({ adapter: productAdapter, nativeBridge: sharedBridge() });
              if (!live || epoch !== bindingEpoch || !current.active) return;
              const row = accounts.accounts.find(row => row.id === accounts.activeId);
              if (!row || row.product !== currentSession.product || mobileAccountIdentity(row) !== mobileAccountIdentity(currentSession)) throw new Error();
              const key = JSON.stringify([identity, row.id, actor]);
              const port = recovery().select({ accounts, session: currentSession, actorApId: actor });
              const reply = (id: string, view: "post" | "profile") => {
                if (feedSessionIdentity(session()) !== identity || home()?.actor.ap_id !== actor) throw new Error("返信の本人scopeが変わりました。");
                return recovery().select({ accounts, session: currentSession, actorApId: actor, replyParentApId: id, replyView: view });
              };
              const profile = () => {
                if (feedSessionIdentity(session()) !== identity || home()?.actor.ap_id !== actor) throw new Error("プロフィールの本人scopeが変わりました。");
                return createProfileRecoveryStore({ store: recovery().accountStorage({ accounts, session: currentSession }),
                  scope: { product: "yurucommu", hostUrl: currentSession.hostUrl, actorApId: actor,
                    ...(currentSession.apiBaseUrl === undefined ? {} : { apiBaseUrl: currentSession.apiBaseUrl }) } });
              };
              setBinding(previous => previous?.key === key ? previous : { key, port, reply, profile }); setBindingError("");
            } catch { if (live && epoch === bindingEpoch) setBindingError("このアカウントの安全な投稿下書き保存先を確認できませんでした。"); }
          })();
        });

        function replyRecovery(target: { apId: string }, view: "post" | "profile") {
          const selected = binding();
          if (!selected) throw new Error("このアカウントの返信下書き保存先を確認できません。投稿を再読み込みしてください。");
          return selected.reply(target.apId, view);
        }

        const [editRevision, setEditRevision] = createSignal(0);
        const edits = createPostEditStore({ session: context.session, onChange: () => setEditRevision(value => value + 1) });
        createRenderEffect(() => edits.updateSession(session()));
        onCleanup(() => edits.clear());
        const [searchRevision, setSearchRevision] = createSignal(0);
        const search = createSearchController({
          session: context.session,
          isActive: () => current.active,
          onChange: () => setSearchRevision(value => value + 1),
          projectPosts: posts => posts.filter(post => !deletedPostIds.has(post.ap_id)).map(post => edits.project(post)),
        });
        const searchState = () => { searchRevision(); return search.getState(); };
        createRenderEffect(() => search.updateSession(session()));
        onCleanup(() => search.dispose());
        function applyPostEdits() {
          profiles.applyPostEdits();notifications.applyPostEdits();
          search.applyPostEdits();
          setHome((value) => withoutDeletedPosts(value));
        }
        const likes = createPostLikeStore({
          session: context.session,
          isActive: () => current.active,
        });
        createRenderEffect(() => likes.updateSession(session()));
        onCleanup(() => likes.dispose());
        const [notificationRevision, setNotificationRevision] = createSignal(0);
        const [bookmarkRevision, setBookmarkRevision] = createSignal(0);
        const [profileRevision, setProfileRevision] = createSignal(0);
        const profiles = createProfileController({
          profileRecovery: () => {
            const selected = binding();
            if (!selected) throw new Error("このアカウントのプロフィール入力保存先を確認できません。");
            return selected.profile();
          },
          replyRecovery: target => replyRecovery(target, "profile"),
          edits,
          onPostEditReceipt: applyPostEdits,
          onPostEditSaved: () => actions().refreshHome(),
          confirmDiscardPostEdit: () => confirmMobileAction({ message: "入力中の投稿編集を閉じますか？未保存の変更は失われます。保存結果が不明な場合は、現在の投稿を確認してください。" }),
          session: context.session,
          isActive: () => current.active,
          onChange: () => setProfileRevision((value) => value + 1),
          onDeclined: () => restoreProfileFocus(),
          onRelationshipChanged: () => actions().refreshHome(),
          onProfileChanged: () => actions().refreshHome(),
          confirmDiscardProfile: () =>
            confirmMobileAction({
              message:
                "入力中のプロフィール変更を破棄して、現在の保存状態を読み直しますか？",
            }),
          onBookmarksChanged: () => setBookmarkRevision((value) => value + 1),
          onPostReplied: () => actions().refreshHome(),
          getActorId: () => home()?.actor.ap_id,
          confirmDeletePost: () => confirmMobileAction({ message: "この投稿を削除しますか？取り消しはできません。" }),
          onPostDeleteConfirmed: (id) => {
            forgetHomePost(id);
            notifications.invalidatePost(id);
            setBookmarkRevision(value => value + 1);
          },
          onPostDeleted: () => actions().refreshHome(),
          confirmDiscardReply: () =>
            confirmMobileAction({
              message:
                "別のプロフィールへ移ると、そのプロフィール内の返信下書き・添付・未確認の送信結果を閉じします。移動しますか？",
            }),
        });
        const profileState = () => {
          profileRevision();
          return profiles.getState();
        };
        createRenderEffect(() => profiles.updateSession(session()));
        onCleanup(() => profiles.dispose());
        const notifications = createNotificationController({
          replyRecovery: target => replyRecovery(target, "post"),
          edits,
          onPostEditReceipt: applyPostEdits,
          onPostEditSaved: () => actions().refreshHome(),
          confirmDiscardPostEdit: () => confirmMobileAction({ message: "入力中の投稿編集を閉じますか？未保存の変更は失われます。保存結果が不明な場合は、現在の投稿を確認してください。" }),
          session: context.session,
          isActive: () => current.active,
          onChange: () => setNotificationRevision((value) => value + 1),
          onBookmarksChanged: () => setBookmarkRevision((value) => value + 1),
          onPostReplied: () => actions().refreshHome(),
          getActorId: () => home()?.actor.ap_id,
          confirmDeletePost: () => confirmMobileAction({ message: "この投稿を削除しますか？取り消しはできません。" }),
          onPostDeleteConfirmed: (id) => {
            forgetHomePost(id);
            profiles.invalidatePosts();
            setBookmarkRevision(value => value + 1);
          },
          onPostDeleted: () => actions().refreshHome(),
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
        let mainRoot: HTMLDivElement | undefined;
        let profileOrigin:
          { trigger: HTMLButtonElement; id: string; scope: string } | undefined;
        const profileFocusScope = () =>
          JSON.stringify([
            feedSessionIdentity(session()),
            session().apiBaseUrl,
          ]);
        const restoreProfileFocus = () =>
          queueMicrotask(() => {
            if (!current.active || profileState().visible) return;
            // Do not move focus away from a control already chosen in the
            // restored view (including a newer post/notification heading).
            if (
              document.activeElement !== document.body &&
              mainRoot?.contains(document.activeElement)
            )
              return;
            const origin = profileOrigin;
            if (origin && origin.scope !== profileFocusScope()) return;
            const target = origin?.trigger.isConnected
              ? origin.trigger
              : (Array.from(
                  mainRoot?.querySelectorAll<HTMLButtonElement>(
                    "button[data-profile-id]",
                  ) ?? [],
                ).find((button) => button.dataset.profileId === origin?.id) ??
                mainRoot);
            if (target?.isConnected) target.focus();
          });
        const openProfile = async (
          identifier: string | null,
          trigger?: HTMLButtonElement,
        ) => {
          if (!current.active) return;
          if (!profileState().visible) {
            profileOrigin = trigger
              ? { trigger, id: identifier ?? "", scope: profileFocusScope() }
              : undefined;
            notifications.pause();
          }
          await profiles.open(identifier);
        };
        const closeProfile = () => {
          profiles.close();
          restoreProfileFocus();
        };
        let homeRoot: HTMLDivElement | undefined;
        let searchRoot: HTMLDivElement | undefined;
        let searchTrigger: HTMLButtonElement | undefined;
        const focusSearch = () => queueMicrotask(() => {
          if (current.active && searchState().visible && !profileState().visible && notificationState().page === "home")
            searchRoot?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
        });
        const closeSearch = () => {
          search.close();
          queueMicrotask(() => {
            if (current.active && !searchState().visible && notificationState().page === "home" && !profileState().visible)
              searchTrigger?.focus();
          });
        };
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
            sessionKey: profileFocusScope(),
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
            profileFocusScope() !== origin.sessionKey
          )
            return;
          if (origin.trigger.isConnected && !origin.trigger.closest("[hidden]"))
            return origin.trigger;
          // A refresh can replace card nodes while detail is open. Resolve the
          // equivalent card within this view using values, never a dynamic selector.
          const root = origin.surface === "search" ? searchRoot : homeRoot;
          return (
            Array.from(
              root?.querySelectorAll<HTMLButtonElement>(
                "button[data-post-id]",
              ) ?? [],
            ).find(
              (button) =>
                button.dataset.postId === origin.id &&
                button.dataset.postSurface === origin.surface,
            ) ?? root
          );
        };
        createRenderEffect(() => {
          if (notificationState().page === "notifications")
            postOrigin = undefined;
        });
        const profileBack = createBackActionSlot();
        const notificationBack = createBackActionSlot();
        const goBack = async () => {
          if (profileState().visible) return profileBack.run();
          if (notificationState().page !== "home") return notificationBack.run();
          if (searchState().visible) closeSearch();
        };
        createRenderEffect(() => {
          const visible = profileState().visible ||
            notificationState().page !== "home" || searchState().visible;
          if (visible) {
            void androidBack?.setTarget({
              owner: current,
              scope: profileFocusScope(),
              isActive: () => current.active,
              back: goBack,
            });
          } else void androidBack?.clear(current);
        });
        onCleanup(() => { void androidBack?.clear(current); });
        const [deferredRoute, setDeferredRoute] = createSignal<NativeNotificationRouteRequest>();
        const routeIsBlocked = () => {
          profileState();
          return profiles.getEditor().getState().visible ||
            !!profiles.getPostController().getState().postEdit?.visible ||
            !!notificationState().postEdit?.visible;
        };
        const routes = createDeferredHostRoute({
          session, isActive: () => current.active, isBlocked: routeIsBlocked,
          onChange: setDeferredRoute,
          open: (request) => {
            if (request.target.page === "search") {
              profiles.close();
              profileOrigin = undefined;
              notifications.showHome();
              search.open(request.target.query, request.target.kind);
              focusSearch();
              return;
            }
            search.close();
            if (request.target.page === "profile") {
              void openProfile(request.target.identifier);
              return;
            }
            profiles.close();
            profileOrigin = undefined;
            if (request.target.page === "notifications")
              void notifications.openNotifications();
            else if (request.target.page === "post")
              void notifications.openPost(request.target.apId);
            else notifications.showHome();
          },
        });
        onCleanup(() => routes.dispose());
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
          routes.receive(request);
        });
        current.updateActions = setActions;
        const release = loader.mount(context, (snapshot) =>
          batch(() => {
            if (
              feedSessionIdentity(snapshot.session) !==
              feedSessionIdentity(session())
            ) {
              deletedPostIds.clear();
              routes.clear();
              postOrigin = undefined;
              profileOrigin = undefined;
              if (adoptedRoute && requestedRoute() === adoptedRoute)
                setRequestedRoute(undefined);
              adoptedRoute = undefined;
              notifications.updateSession(snapshot.session);
            }
            setSession(snapshot.session);
            setHome(withoutDeletedPosts(snapshot.home));
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
            <Show when={deferredRoute()}>
              <p role="status" data-deferred-host-route>
                編集画面を閉じてから、リンク先を開いてください。
                <button type="button" class="text-button" disabled={routeIsBlocked()}
                  onClick={() => routes.retry()}>リンク先を開く</button>
                <button type="button" class="text-button" onClick={() => routes.clear()}>取り消す</button>
              </p>
            </Show>
            <ProfileScreen
              session={session()}
              controller={profiles}
              revision={profileRevision()}
              likes={likes}
              isActive={() => current.active}
              onClose={closeProfile}
              onOpenProfile={openProfile}
              registerBackAction={profileBack.register}
            />
            <div ref={mainRoot} tabIndex={-1} hidden={profileState().visible}>
              <NotificationScreen
                onOpenProfile={openProfile}
                session={session()}
                state={notificationState()}
                controller={notifications}
                isActive={() => current.active && !profileState().visible}
                homeFocus={homeFocus}
                likes={likes}
                registerBackAction={notificationBack.register}
              />
              <div ref={searchRoot} tabIndex={-1}>
                <SearchScreen
                  session={session()} state={searchState()} controller={search}
                  visible={searchState().visible && notificationState().page === "home" && !profileState().visible}
                  isActive={() => current.active} onClose={closeSearch}
                  onOpenPost={openPost} onOpenProfile={openProfile}
                />
              </div>
              <div
                ref={homeRoot}
                tabIndex={-1}
                role="region"
                aria-label="フィードと保存した投稿"
                hidden={notificationState().page !== "home" || searchState().visible}
              >
                <button ref={searchTrigger} type="button" class="text-button"
                  onClick={() => { search.open(); focusSearch(); }}>投稿・ユーザーを検索</button>
                <Show when={bindingError()}><div role="alert"><p>{bindingError()}</p>
                  <button type="button" class="text-button" onClick={() => setBindingRetry(value => value + 1)}>投稿下書きの保存先を再確認</button>
                </div></Show>
                <Show when={binding()} keyed fallback={<p role="status">投稿下書きの保存先を確認中…</p>}>
                  {selected =>
                <Feed
                  recovery={selected.port}
                  home={home()}
                  projectPosts={projectHomePosts}
                  session={session()}
                  refreshHome={() => actions().refreshHome()}
                  likes={likes}
                  likeActionsActive={() =>
                    notificationState().page === "home" &&
                    !profileState().visible && !searchState().visible
                  }
                  isActive={() => current.active}
                  onOpenPost={openPost}
                  onOpenProfile={openProfile}
                />
                  }
                </Show>
                <BookmarksPreview
                  edits={edits}
                  editRevision={editRevision()}
                  likes={likes}
                  likeActionsActive={() =>
                    notificationState().page === "home" &&
                    !profileState().visible && !searchState().visible
                  }
                  revision={bookmarkRevision()}
                  session={session()}
                  isActive={() => current.active}
                  onOpenPost={openPost}
                  onOpenProfile={openProfile}
                />
              </div>
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
    // Remains mounted across sign-out: a failed native removal must stay
    // recoverable even after the account-owned feed view has been retired.
    BackRecovery: () => <><Show when={cleanupCheckError()}><div role="alert">
      <p>未完の保存入力の削除を確認できませんでした。保存データは削除していません。</p>
      <button type="button" class="text-button" disabled={cleaning()} onClick={() => void retryCleanup()}>保存入力の削除確認を再試行</button>
    </div></Show><Show when={cleanupFailures().length}><div role="alert">
      <p>サインアウト済みアカウントの投稿・返信・プロフィール入力の削除を確認できませんでした。</p>
      <button type="button" class="text-button" disabled={cleaning()} onClick={() => void retryCleanup()}>保存入力の削除を再試行</button>
    </div></Show><Show when={backFailure()}>
      <div role="alert">
        <p>Androidの戻る操作を更新できませんでした。画面内の「戻る」を使い、再接続を試してください。</p>
        <button type="button" class="text-button" onClick={() => void androidBack?.retry()}>
          Androidの戻る操作を再接続
        </button>
      </div>
    </Show></>,
    onAccountScopeRetired: cleanupScope,
    disposeAndroidBack: () => androidBack?.dispose() ?? Promise.resolve(),
    adapter: productAdapter,
    createNativeBridge: sharedBridge,
    loadHome: (session) => {
      setRequestedRoute(current => pendingHostRouteForSession(current, session));
      return loader.load(session);
    },
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
