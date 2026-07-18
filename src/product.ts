import type { MobileProductAdapter } from "@takosjp/mobile-kit";

export const productAdapter: MobileProductAdapter = {
  product: "yurucommu",
  appName: "Yurucommu",
  hostNoun: "Yurucommu server",
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
  accentColor: "#ff7f6e",
  mobileScheme: "yurucommu",
  oidcScopes: ["openid", "profile", "email", "offline_access"],
};
