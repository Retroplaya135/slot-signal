export type TrustCenterLink = {
  id: "privacy" | "safe-use" | "known-limitations" | "feedback" | "security";
  label: string;
  path:
    | "/trust/privacy.html"
    | "/trust/safe-use.html"
    | "/trust/known-limitations.html"
    | "/trust/feedback.html"
    | "/trust/security.html";
  summary: string;
  status: "draft" | "review-ready";
};

export const TRUST_CENTER_LABEL = "Slot Signal Trust Center";

export const TRUST_CENTER_LINKS: TrustCenterLink[] = [
  {
    id: "privacy",
    label: "Privacy Notice",
    path: "/trust/privacy.html",
    status: "review-ready",
    summary: "Community signal, sharing limits, and support export redaction."
  },
  {
    id: "safe-use",
    label: "Safe Use Terms",
    path: "/trust/safe-use.html",
    status: "review-ready",
    summary: "Human-confirmed booking boundary and prohibited use patterns."
  },
  {
    id: "known-limitations",
    label: "Known Limitations",
    path: "/trust/known-limitations.html",
    status: "review-ready",
    summary: "What works in the local MVP and what is still blocked."
  },
  {
    id: "feedback",
    label: "Feedback",
    path: "/trust/feedback.html",
    status: "review-ready",
    summary: "Safe beta feedback rules and sensitive-file warnings."
  },
  {
    id: "security",
    label: "Security Boundary",
    path: "/trust/security.html",
    status: "review-ready",
    summary: "No remote code, no hidden submit, and no live portal requests."
  }
];

export const TRUST_CENTER_CLAIMS = [
  "No live portal requests",
  "No unattended booking",
  "No portal passwords stored",
  "No provider credentials configured",
  "No remote code"
] as const;
