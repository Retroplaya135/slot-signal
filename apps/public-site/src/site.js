const accessForm = document.querySelector("[data-access-form]");
const accessInput = document.querySelector("[data-access-code]");
const accessOutput = document.querySelector("[data-access-output]");
const installCtas = document.querySelectorAll("[data-install-cta]");
const chromeReferenceLinks = document.querySelectorAll("[data-chrome-reference]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const THEME_KEY = "visaSignalSiteTheme";

const siteConfig = window.SLOT_SIGNAL_SITE_CONFIG && typeof window.SLOT_SIGNAL_SITE_CONFIG === "object"
  ? window.SLOT_SIGNAL_SITE_CONFIG
  : {};

function safeInstallUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["https:", "file:"].includes(url.protocol)) return "";
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) return "";
    if (url.hostname.endsWith(".example") || url.hostname.endsWith(".invalid") || url.hostname.endsWith(".test")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function maskCode(value) {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.min(8, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

function preferredTheme() {
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (document.body.classList.contains("dashboard-page")) return "light";
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  if (themeToggle) {
    themeToggle.textContent = normalized === "dark" ? "Light" : "Dark";
    themeToggle.setAttribute("aria-label", `Switch to ${normalized === "dark" ? "light" : "dark"} theme`);
  }
}

applyTheme(preferredTheme());

if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    window.localStorage.setItem(THEME_KEY, nextTheme);
    applyTheme(nextTheme);
  });
}

if (accessForm && accessInput && accessOutput) {
  const storedCode = window.localStorage.getItem("visaSignalAccessCode");
  if (storedCode) {
    accessOutput.textContent = `Access code saved in this browser: ${maskCode(storedCode)}. Open the extension and enter the same code there.`;
  }

  accessForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = accessInput.value.trim();
    if (value.length < 6) {
      accessOutput.textContent = "Enter the access code issued for your beta account.";
      return;
    }
    window.localStorage.setItem("visaSignalAccessCode", value);
    accessOutput.textContent = `Access code saved in this browser: ${maskCode(value)}. The extension will still require its own access key before connecting to the API.`;
    accessInput.value = "";
  });
}

const extensionInstallUrl = safeInstallUrl(siteConfig.extensionInstallUrl);
const chromeReferenceUrl = safeInstallUrl(siteConfig.chromeReferenceUrl) || "https://chromewebstore.google.com/category/extensions";
chromeReferenceLinks.forEach((link) => {
  if (!(link instanceof HTMLAnchorElement)) return;
  link.href = chromeReferenceUrl;
});

installCtas.forEach((link) => {
  if (!(link instanceof HTMLAnchorElement)) return;
  if (!extensionInstallUrl) {
    link.textContent = "Request access";
    link.href = "/access.html";
    link.removeAttribute("target");
    link.removeAttribute("rel");
    link.dataset.installState = "request_access";
    return;
  }
  link.textContent = "Install beta extension";
  link.href = extensionInstallUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.dataset.installState = "install_available";
});
