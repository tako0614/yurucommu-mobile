import { renderMobileClientApp } from "@takosjp/mobile-kit/solid";
import { createYurucommuMobileApp } from "./mobile-app.tsx";
import { createProductNativeBridge } from "./native.ts";
import "./styles.css";

renderMobileClientApp(createYurucommuMobileApp(createProductNativeBridge));
