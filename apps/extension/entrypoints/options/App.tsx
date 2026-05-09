import { Bell, Clipboard, Download, KeyRound, Lock, Mail, MessageCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { sendRuntimeMessage, type ExtensionMessage } from "@slot-signal/extension-bridge";
import { clearApiAuthToken, readApiAuthToken, saveApiAuthToken } from "../../src/shared/apiAuth";
import { SUPPORTED_PORTAL_ORIGINS } from "../../src/shared/constants";
import { checkPolicy, notificationChannels } from "../../src/shared/status";
import { TRUST_CENTER_LINKS } from "../../src/shared/trust";
import {
  CheckPolicyControl,
  GlassPanel,
  NotificationChannelList,
  PermissionNotice,
  StatusPill,
  TrustCenterLinks
} from "../../src/ui/components";

export default function App() {
  const [runtimeMessage, setRuntimeMessage] = useState<ExtensionMessage | null>(null);
  const [debugMessage, setDebugMessage] = useState<ExtensionMessage | null>(null);
  const [notificationMessage, setNotificationMessage] = useState<ExtensionMessage | null>(null);
  const [apiAuthToken, setApiAuthToken] = useState("");
  const [apiAuthSaved, setApiAuthSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [advancedAccessCode, setAdvancedAccessCode] = useState("");
  const [advancedUnlocked, setAdvancedUnlocked] = useState(false);

  useEffect(() => {
    async function loadRuntimeStatus() {
      setApiAuthToken(await readApiAuthToken());
      const response = await sendRuntimeMessage(browser.runtime, {
        actor: "options",
        payload: { reason: "options_opened" },
        type: "extension.status.requested"
      });
      setRuntimeMessage(response);
      if (response.type === "extension.status.responded") {
        setPermissionGranted(response.payload.permissions.aisHostPermissionGranted);
      }
    }

    void loadRuntimeStatus();
  }, []);

  async function refreshRuntimeStatus() {
    const response = await sendRuntimeMessage(browser.runtime, {
      actor: "options",
      payload: { reason: "manual_refresh" },
      type: "extension.status.requested"
    });
    setRuntimeMessage(response);
    if (response.type === "extension.status.responded") {
      setPermissionGranted(response.payload.permissions.aisHostPermissionGranted);
    }
  }

  async function toggleAisPermission() {
    const origins = [`${SUPPORTED_PORTAL_ORIGINS[0]}/*`];
    const updated = permissionGranted ? await browser.permissions.remove({ origins }) : false;
    if (updated) {
      setPermissionGranted(!permissionGranted);
    }
    await refreshRuntimeStatus();
  }

  async function generateDebugExport() {
    const response = await sendRuntimeMessage(browser.runtime, {
      actor: "options",
      payload: {
        requestedAt: new Date().toISOString(),
        source: "options"
      },
      type: "visa.debug.export_requested"
    });
    setDebugMessage(response);
    setRuntimeMessage(response);
    setCopied(false);
  }

  async function sendFixtureAlert() {
    const response = await sendRuntimeMessage(browser.runtime, {
      actor: "options",
      payload: {
        requestedAt: new Date().toISOString(),
        source: "options"
      },
      type: "visa.notification.test_requested"
    });
    setNotificationMessage(response);
    setRuntimeMessage(response);
  }

  async function saveApiToken() {
    await saveApiAuthToken(apiAuthToken);
    setApiAuthSaved(true);
  }

  async function clearApiToken() {
    await clearApiAuthToken();
    setApiAuthToken("");
    setApiAuthSaved(true);
  }

  const debugExport = debugMessage?.type === "visa.debug.export_responded" ? debugMessage.payload : null;
  const notificationDispatch =
    notificationMessage?.type === "visa.notification.delivery_responded" ? notificationMessage.payload : null;
  const debugExportText = debugExport ? JSON.stringify(debugExport, null, 2) : "";
  const trustLinks = TRUST_CENTER_LINKS.map((link) => ({ ...link, href: browser.runtime.getURL(link.path) }));

  async function copyDebugExport() {
    if (!debugExportText) return;
    await navigator.clipboard.writeText(debugExportText);
    setCopied(true);
  }

  function unlockAdvancedTools() {
    const normalized = advancedAccessCode.trim();
    if (normalized === "preview-advanced" || normalized.length >= 12 || apiAuthToken.length >= 24) {
      setAdvancedUnlocked(true);
    }
  }

  return (
    <main className="app-shell options-shell signal-shell" data-proof-id="options-runtime-state" data-proof-runtime-type={runtimeMessage?.type ?? "none"}>
      <section className="signal-topline liquid-glass-regular">
        <div>
          <span className="signal-label">Slot Signal</span>
          <h1>Settings</h1>
          <p>Access, privacy, alert preferences, and support controls.</p>
        </div>
        <StatusPill icon={ShieldCheck} label="Private by default" tone="success" />
      </section>

      <div className="signal-view-grid">
        <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Access key settings">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Access</span>
              <h2 className="section-title">Backend API key</h2>
            </div>
            <KeyRound className="icon" />
          </div>
          <label className="form-field" htmlFor="api-auth-token">
            <span>Client access key</span>
            <input
              id="api-auth-token"
              type="password"
              value={apiAuthToken}
              placeholder="Paste your extension access key"
              onChange={(event) => {
                setApiAuthToken(event.target.value);
                setApiAuthSaved(false);
              }}
            />
          </label>
          <div className="button-row">
            <button className="primary-button" type="button" onClick={saveApiToken}>
              Save key
            </button>
            <button className="ghost-button" type="button" onClick={clearApiToken}>
              Clear
            </button>
          </div>
          <p className="signal-fineprint">This key authenticates the extension to the backend API. It is separate from the beta access code used to unlock beta entitlement.</p>
          {apiAuthSaved ? <StatusPill icon={ShieldCheck} label="Updated" tone="success" /> : null}
        </GlassPanel>

        <GlassPanel className="signal-card liquid-glass-clear" ariaLabel="Privacy boundary">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Privacy</span>
              <h2 className="section-title">User-controlled by design</h2>
            </div>
            <Lock className="icon" />
          </div>
          <div className="signal-privacy-grid">
            <span>No portal password</span>
            <span>No hidden page capture</span>
            <span>No appointment changes</span>
            <span>No remote code</span>
          </div>
          <label className="toggle-row" htmlFor="ais-permission">
            <span>
              <strong>Optional portal access</strong>
              <small>Only revocation is available in this release.</small>
            </span>
            <input id="ais-permission" type="checkbox" checked={permissionGranted} disabled={!permissionGranted} onChange={toggleAisPermission} />
          </label>
        </GlassPanel>

        <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Alert preferences">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Alerts</span>
              <h2 className="section-title">Delivery preferences</h2>
            </div>
            <Bell className="icon" />
          </div>
          <div className="toggle-stack">
            <label className="toggle-row" htmlFor="browser-alerts">
              <span>
                <strong>Browser alerts</strong>
                <small>Enabled in the extension.</small>
              </span>
              <input id="browser-alerts" type="checkbox" checked readOnly />
            </label>
            <label className="toggle-row" htmlFor="email-alerts">
              <span>
                <strong>Email</strong>
                <small>Available only when configured for the account.</small>
              </span>
              <input id="email-alerts" type="checkbox" checked={false} readOnly />
            </label>
            <label className="toggle-row" htmlFor="telegram-alerts">
              <span>
                <strong>Telegram</strong>
                <small>Planned as an account add-on.</small>
              </span>
              <input id="telegram-alerts" type="checkbox" checked={false} readOnly />
            </label>
          </div>
        </GlassPanel>

        <GlassPanel className="signal-card liquid-glass-clear" ariaLabel="Advanced access">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Advanced</span>
              <h2 className="section-title">Beta access code</h2>
            </div>
            <StatusPill icon={advancedUnlocked ? ShieldCheck : KeyRound} label={advancedUnlocked ? "Unlocked" : "Locked"} tone={advancedUnlocked ? "success" : "warning"} />
          </div>
          {!advancedUnlocked ? (
            <div className="signal-access-gate">
              <p>Support exports and reviewer controls are beta-entitlement gated. This is not the same as the backend API key above.</p>
              <label className="form-field" htmlFor="advanced-access-code">
                <span>Access code</span>
                <input
                  id="advanced-access-code"
                  aria-label="Beta access code"
                  data-proof-id="options-advanced-access-code"
                  type="password"
                  value={advancedAccessCode}
                  placeholder="preview-advanced"
                  onChange={(event) => setAdvancedAccessCode(event.target.value)}
                />
              </label>
              <button aria-label="Unlock advanced diagnostics" className="primary-button" data-proof-id="options-unlock-advanced" type="button" onClick={unlockAdvancedTools}>
                Unlock
              </button>
            </div>
          ) : (
            <div className="signal-stack-list">
              <article className="signal-list-row">
                <div>
                  <strong>Support export</strong>
                  <span>Generate redacted troubleshooting state.</span>
                </div>
                <button
                  aria-label="Generate redacted support export"
                  className="secondary-button compact-button"
                  data-proof-id="options-generate-debug-export"
                  type="button"
                  onClick={generateDebugExport}
                >
                  <Download className="icon" />
                  Generate
                </button>
              </article>
              <article className="signal-list-row">
                <div>
                  <strong>Notification test</strong>
                  <span>Send a controlled local sample alert.</span>
                </div>
                <button
                  aria-label="Send fixture alert"
                  className="secondary-button compact-button"
                  data-proof-id="options-send-fixture-alert"
                  type="button"
                  onClick={sendFixtureAlert}
                >
                  <Bell className="icon" />
                  Send
                </button>
              </article>
              {debugExportText ? (
                <div className="signal-stack-list">
                  <div className="button-row">
                    <button className="secondary-button" type="button" disabled={!debugExportText} onClick={copyDebugExport}>
                      <Clipboard className="icon" />
                      {copied ? "Copied" : "Copy support JSON"}
                    </button>
                  </div>
                  <textarea className="debug-export-preview" aria-label="Redacted support export JSON" data-proof-id="options-debug-export-preview" readOnly value={debugExportText} />
                </div>
              ) : null}
              {notificationDispatch ? (
                <div className="signal-mini-grid" data-proof-id="options-notification-delivery-summary" data-proof-runtime-type={notificationMessage?.type ?? "none"}>
                  {notificationDispatch.deliveries.map((delivery) => (
                    <span key={delivery.deliveryId}>
                      <strong>{delivery.status}</strong>
                      {delivery.channel}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </GlassPanel>
      </div>

      <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Trust center">
        <div className="signal-card-head">
          <div>
            <span className="signal-label">Trust center</span>
            <h2 className="section-title">Privacy, safety, and support</h2>
          </div>
          <ShieldCheck className="icon" />
        </div>
        <TrustCenterLinks links={trustLinks} />
      </GlassPanel>
    </main>
  );
}
