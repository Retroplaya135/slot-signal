import { defineConfig } from "wxt";

const wxtBrowserModule = new URL("./node_modules/wxt/dist/browser.mjs", import.meta.url).pathname;
const localBackendHostPermissions = ["http://127.0.0.1:8000/*", "http://localhost:8000/*"];
const localOptionalAisHostPermissions = ["https://ais.usvisa-info.com/*"];

function extensionProfile() {
  return import.meta.env.WXT_EXTENSION_PROFILE === "store" ? "store" : "local";
}

function productionApiOrigin() {
  const rawOrigin = import.meta.env.WXT_PUBLIC_API_ORIGIN?.trim();
  if (!rawOrigin) {
    throw new Error("Store profile requires WXT_PUBLIC_API_ORIGIN.");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error(`Invalid WXT_PUBLIC_API_ORIGIN: ${rawOrigin}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Store profile requires WXT_PUBLIC_API_ORIGIN to use https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Store profile WXT_PUBLIC_API_ORIGIN must not include credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Store profile WXT_PUBLIC_API_ORIGIN must be an origin only, with no path, query, or hash.");
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname)) {
    throw new Error("Store profile WXT_PUBLIC_API_ORIGIN must not be localhost.");
  }
  if (parsed.hostname.includes("*")) {
    throw new Error("Store profile WXT_PUBLIC_API_ORIGIN must not include wildcards.");
  }
  if (parsed.hostname === "ais.usvisa-info.com" || parsed.hostname.endsWith(".ais.usvisa-info.com")) {
    throw new Error("Store profile WXT_PUBLIC_API_ORIGIN must not target AIS.");
  }
  return parsed.origin;
}

export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    resolve: {
      alias: {
        "wxt/browser": wxtBrowserModule
      }
    }
  }),
  manifest: () => {
    const profile = extensionProfile();
    const storeApiOrigin = profile === "store" ? productionApiOrigin() : null;
    return {
      name: profile === "store" ? "Slot Signal Preview" : "Slot Signal",
      short_name: "Visa Tracker",
      description: "Track visa appointment candidates and show user-reviewed context. Does not book appointments.",
      version: "0.1.0",
      permissions: ["sidePanel", "notifications", "storage"],
      host_permissions: profile === "store" ? [`${storeApiOrigin}/*`] : localBackendHostPermissions,
      optional_host_permissions: profile === "store" ? [] : localOptionalAisHostPermissions,
      action: {
        default_title: "Slot Signal"
      }
    };
  }
});
