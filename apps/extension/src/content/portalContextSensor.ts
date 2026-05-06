import { browser } from "wxt/browser";
import { createEnvelope } from "@slot-signal/contracts";
import { SUPPORTED_PORTAL_ORIGINS } from "../shared/constants";

export function reportPortalContext() {
  const origin = window.location.origin;
  const supported = origin === SUPPORTED_PORTAL_ORIGINS[0];

  void browser.runtime.sendMessage(createEnvelope({
    actor: "content_script",
    payload: {
      supported,
      origin: SUPPORTED_PORTAL_ORIGINS[0],
      path: window.location.pathname,
      stage: "scaffold_only"
    },
    type: "visa.portal.context_detected"
  }));
}
