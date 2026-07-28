import type { MobileProductAdapter } from "@takosjp/mobile-kit";

export const productAdapter: MobileProductAdapter = {
  product: "yurucommu",
  strictDiscoveryProduct: true,
  appName: "Yurucommu",
  // Reads inside Japanese status sentences, so the noun is Japanese too.
  hostNoun: "Yurucommu サーバー",
  hostCenterLabel: "Takosumi",
  hostCenterUrl: "https://app.takosumi.com/new",
  hostCenterProduct: "yurucommu",
  hostCenterSource: { git: "https://github.com/tako0614/yurucommu.git" },
  directDeployLabel: "Cloudflare",
  directDeployUrl:
    "https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurucommu",
  directDeployDescription: "Cloudflareへ直接デプロイして接続する",
  urlPlaceholder: "https://your-yurucommu.example",
  primaryActionLabel: "つなぐ",
  // Single Yurucommu brand accent, kept equal to `--accent` in
  // `yurucommu/src/styles.css` (blue-500) so mobile and web agree.
  accentColor: "#3b82f6",
  mobileScheme: "yurucommu",
  // The provider token is exchanged immediately for a host-local bearer.
  // Email and offline access are not required by the native client.
  oidcScopes: ["openid", "profile"],
  requiredHostCapabilities: [
    "api.social.v1",
    "client.yurucommu.feed.v1",
  ],
};
