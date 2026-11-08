import { render } from "solid-js/web";
import { YurucommuMobileApp } from "./mobile-app.tsx";
import { createProductNativeBridge } from "./native.ts";
import { registerProductAndroidBack } from "./android-back-native.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Yurucommu app root not found");
const dispose = render(() => <YurucommuMobileApp
  createNativeBridge={createProductNativeBridge}
  registerAndroidBack={registerProductAndroidBack}
/>, root);
if (import.meta.hot) import.meta.hot.dispose(dispose);
