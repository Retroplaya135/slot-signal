import { Gauge, PanelRightOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { sendRuntimeMessage, type ExtensionMessage } from "@slot-signal/extension-bridge";
import { MIN_SCHEDULED_CHECK_MINUTES, PRODUCT_BOUNDARY } from "../../src/shared/constants";
import { cooldownState, statusModel } from "../../src/shared/status";
import { CooldownBanner, PermissionNotice, StatusPill } from "../../src/ui/components";

export default function App() {
  const StatusIcon = statusModel.icon;
  const [runtimeMessage, setRuntimeMessage] = useState<ExtensionMessage | null>(null);

  useEffect(() => {
    void requestStatus("popup_opened");
  }, []);

  async function requestStatus(reason: "popup_opened" | "manual_refresh") {
    const response = await sendRuntimeMessage(browser.runtime, {
      actor: "popup",
      payload: { reason },
      type: "extension.status.requested"
    });
    setRuntimeMessage(response);
  }

  async function openSidePanel() {
    const response = await sendRuntimeMessage(browser.runtime, {
      actor: "popup",
      payload: {
        requestedAt: new Date().toISOString(),
        source: "popup"
      },
      type: "extension.sidepanel.open_requested"
    });
    setRuntimeMessage(response);
  }

  async function checkNow() {
    const response = await sendRuntimeMessage(browser.runtime, {
      actor: "popup",
      payload: {
        livePortalChecksEnabled: false,
        reason: "manual_check",
        requestedAt: new Date().toISOString(),
        source: "popup"
      },
      type: "visa.availability.check_requested"
    });
    setRuntimeMessage(response);
  }

  return (
    <main className="app-shell popup-shell signal-shell">
      <section className="popup-card signal-popup-card liquid-glass-regular">
        <div className="signal-card-head">
          <div>
            <span className="signal-label">Slot Signal</span>
            <h1 className="title">Watch status</h1>
          </div>
          <StatusPill icon={StatusIcon} label={statusModel.label} tone={statusModel.tone} />
        </div>

        <div className="signal-popup-status" data-tone={statusModel.tone}>
          <StatusIcon className="status-icon-large" />
          <div>
            <strong>Community signals are ready.</strong>
            <p>Open the side panel to add a report, sync alerts, or review your watchlist.</p>
          </div>
        </div>

        <div className="signal-mini-grid">
          <span>
            <strong>{statusModel.lastCheck}</strong>
            Last sync
          </span>
          <span>
            <strong>{statusModel.nextCheck}</strong>
            Next window
          </span>
        </div>

        <div className="button-grid">
          <button className="primary-button" type="button" onClick={openSidePanel}>
            <PanelRightOpen className="icon" />
            Open side panel
          </button>

          <button className="ghost-button" type="button" onClick={checkNow}>
            <RefreshCw className="icon" />
            Refresh status
          </button>
        </div>

        {runtimeMessage ? (
          <section className="signal-inline-alert" data-tone={runtimeMessage.type === "error.client_reported" ? "danger" : "success"}>
            <strong>{runtimeMessage.type === "error.client_reported" ? "Needs attention" : "Updated"}</strong>
            <span>{runtimeMessage.type === "error.client_reported" ? runtimeMessage.payload.message : "Status refreshed."}</span>
          </section>
        ) : null}

        <div className="policy-foot">
          <Gauge className="icon" />
          <span>Community signals only. Booking remains manual.</span>
        </div>
      </section>
    </main>
  );
}
