import fs from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(new URL("..", import.meta.url).pathname);
const srcRoot = path.join(appRoot, "src");
const distRoot = path.join(appRoot, "dist");
const projectRoot = path.resolve(appRoot, "../..");

function normalizedInstallUrl() {
  const raw = process.env.SLOT_SIGNAL_PUBLIC_EXTENSION_INSTALL_URL?.trim() ?? "";
  if (!raw) return "";
  return raw;
}

function normalizedDashboardApiBaseUrl() {
  const raw = process.env.SLOT_SIGNAL_DASHBOARD_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  if (!raw) return "http://127.0.0.1:8000/v1";
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("SLOT_SIGNAL_DASHBOARD_API_BASE_URL must use HTTP or HTTPS.");
  if (parsed.username || parsed.password) throw new Error("SLOT_SIGNAL_DASHBOARD_API_BASE_URL must not include credentials.");
  return raw;
}

function normalizedChromeReferenceUrl() {
  const raw = process.env.SLOT_SIGNAL_CHROME_REFERENCE_URL?.trim() ?? "";
  if (!raw) return "https://chromewebstore.google.com/category/extensions";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("SLOT_SIGNAL_CHROME_REFERENCE_URL must use HTTPS.");
  return parsed.href;
}

function normalizedPublicSiteOrigin() {
  const raw = process.env.SLOT_SIGNAL_PUBLIC_SITE_ORIGIN?.trim().replace(/\/+$/, "") ?? "";
  if (!raw) return "https://slot-signal.example";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("SLOT_SIGNAL_PUBLIC_SITE_ORIGIN must use HTTPS.");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("SLOT_SIGNAL_PUBLIC_SITE_ORIGIN must be an origin only.");
  return parsed.origin;
}

async function replacePublicOrigin(root, publicSiteOrigin) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await replacePublicOrigin(target, publicSiteOrigin);
      continue;
    }
    if (!/\.(html|txt|xml)$/u.test(entry.name)) continue;
    const source = await fs.readFile(target, "utf8");
    await fs.writeFile(target, source.replaceAll("__SLOT_SIGNAL_PUBLIC_ORIGIN__", publicSiteOrigin));
  }
}

async function latestExtensionZip() {
  const outputRoot = path.join(projectRoot, "apps/extension/.output");
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  const zips = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    const zipPath = path.join(outputRoot, entry.name);
    const stat = await fs.stat(zipPath);
    zips.push({ mtimeMs: stat.mtimeMs, path: zipPath });
  }
  zips.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return zips[0]?.path ?? null;
}

async function copyDir(from, to) {
  await fs.rm(to, { force: true, recursive: true });
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(source, target);
    } else {
      await fs.copyFile(source, target);
    }
  }
}

async function readExistingDownloads() {
  const downloadsRoot = path.join(distRoot, "downloads");
  const entries = await fs.readdir(downloadsRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(downloadsRoot, entry.name);
    files.push({ bytes: await fs.readFile(filePath), name: entry.name });
  }
  return files;
}

async function restoreDownloads(files) {
  if (!files.length) return;
  const downloadsRoot = path.join(distRoot, "downloads");
  await fs.mkdir(downloadsRoot, { recursive: true });
  await Promise.all(files.map((file) => fs.writeFile(path.join(downloadsRoot, file.name), file.bytes)));
}

const existingDownloads = await readExistingDownloads();
await copyDir(srcRoot, distRoot);
await restoreDownloads(existingDownloads);
const publicSiteOrigin = normalizedPublicSiteOrigin();
await replacePublicOrigin(distRoot, publicSiteOrigin);
const includeBetaPackage = process.env.SLOT_SIGNAL_PUBLIC_INCLUDE_BETA_PACKAGE === "true";
let extensionInstallUrl = normalizedInstallUrl();
let betaPackagePath = "";
if (includeBetaPackage) {
  const zipPath = await latestExtensionZip();
  if (!zipPath) throw new Error("SLOT_SIGNAL_PUBLIC_INCLUDE_BETA_PACKAGE=true requires an extension zip in apps/extension/.output.");
  const downloadsDir = path.join(distRoot, "downloads");
  await fs.mkdir(downloadsDir, { recursive: true });
  betaPackagePath = "downloads/slot-signal-beta.zip";
  await fs.copyFile(zipPath, path.join(distRoot, betaPackagePath));
  extensionInstallUrl ||= `${publicSiteOrigin}/${betaPackagePath}`;
}
await fs.writeFile(
  path.join(distRoot, "site-config.js"),
  `window.SLOT_SIGNAL_SITE_CONFIG = ${JSON.stringify({
    chromeReferenceUrl: normalizedChromeReferenceUrl(),
    dashboardApiBaseUrl: normalizedDashboardApiBaseUrl(),
    extensionInstallUrl
  }, null, 2)};\n`
);
await fs.writeFile(
  path.join(distRoot, "build-manifest.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      pages: ["/", "/dashboard.html", "/trust.html", "/access.html", "/support.html"],
      delivery: "static-public-site",
      betaPackageIncluded: includeBetaPackage,
      betaPackagePath,
      dashboardApiBaseUrlConfigured: Boolean(normalizedDashboardApiBaseUrl()),
      extensionInstallUrlConfigured: Boolean(extensionInstallUrl),
      productDelivery: "chrome-extension",
      accessMode: "issued-access-code"
    },
    null,
    2
  )
);

console.log(JSON.stringify({ distRoot, status: "built" }, null, 2));
