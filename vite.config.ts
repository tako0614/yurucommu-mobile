import solid from "vite-plugin-solid";
import { createTauriMobileViteConfig } from "@takosjp/mobile-kit/vite";

export default createTauriMobileViteConfig({
  devPort: 1430,
  importMetaUrl: import.meta.url,
  resolveMobileKitFromPackage: true,
  plugins: [solid()],
});
