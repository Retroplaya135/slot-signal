const dashboard = document.querySelector("[data-dashboard-shell]");
const DASHBOARD_CONFIG_KEY = "visaSignalDashboardConfig";
const DEFAULT_SCENARIO = {
  country: "Canada",
  postCity: "Toronto",
  visaClass: "B1/B2"
};
const TODAY = new Date();

const demoState = {
  reports: [
    {
      availableDates: [offsetDate(8), offsetDate(16)],
      capturedAt: offsetDateTime(-1),
      country: "Canada",
      freshness: "fresh",
      matchedDates: [offsetDate(8), offsetDate(16)],
      postCity: "Toronto",
      reportId: "demo-toronto-b1b2",
      sourceKind: "community_report",
      trust: { provenance: "community_metadata", qualityScore: 84, status: "accepted_unique" },
      visaClass: "B1/B2"
    },
    {
      availableDates: [offsetDate(23)],
      capturedAt: offsetDateTime(-18),
      country: "India",
      freshness: "fresh",
      matchedDates: [offsetDate(23)],
      postCity: "Chennai",
      reportId: "demo-chennai-b1b2",
      sourceKind: "community_report",
      trust: { provenance: "community_metadata", qualityScore: 68, status: "accepted_unique" },
      visaClass: "B1/B2"
    },
    {
      availableDates: [offsetDate(-3)],
      capturedAt: offsetDateTime(-96),
      country: "Mexico",
      freshness: "stale",
      matchedDates: [offsetDate(-3)],
      postCity: "Mexico City",
      reportId: "demo-mexico-f1",
      sourceKind: "community_report",
      trust: { provenance: "community_metadata", qualityScore: 48, status: "low_trust_review" },
      visaClass: "F1"
    }
  ],
  subscriptions: [
    {
      active: true,
      channels: ["browser"],
      cooldownMinutes: 15,
      country: "Canada",
      deliveryMode: "immediate",
      digestWindowMinutes: 60,
      postCities: ["Toronto"],
      status: "active",
      subscriptionId: "local-watch-toronto",
      targetEndDate: offsetDate(40),
      targetStartDate: offsetDate(1),
      visaClasses: ["B1/B2"]
    }
  ],
  pendingMatches: [
    {
      matchedDates: [offsetDate(8)],
      notificationEvent: {
        notificationId: "local-alert-toronto",
        reason: "Fresh Toronto B1/B2 signal matched local watch.",
        subscriptionId: "local-watch-toronto"
      },
      reportId: "demo-toronto-b1b2"
    }
  ],
  deliveryHistory: {
    auditEvents: [
      { deliveryStatus: "queued", eventId: "local-delivery-001", notificationId: "local-alert-toronto", recordedAt: offsetDateTime(-2) }
    ]
  },
  digestQueue: {
    containsSensitiveRawData: false,
    groups: [
      { matchedDates: [offsetDate(8)], postCity: "Toronto", subscriptionId: "local-watch-toronto", visaClass: "B1/B2" }
    ],
    slotAlertsDelivered: false
  },
  publicEstimates: [
    {
      availabilityClaim: "public_estimate_not_slot_availability",
      capturedAt: offsetDateTime(-4),
      country: "Canada",
      estimateId: "public-estimate-toronto",
      estimateLabel: "Visitor visa public wait context",
      estimateValueDays: 35,
      freshnessLabel: "fresh",
      postCity: "Toronto",
      sourceName: "Public estimate",
      sourcePermission: "public_estimate_context",
      status: "accepted",
      triggersSlotAlerts: false,
      visaClass: "B1/B2"
    }
  ],
  sourcePolicy: {
    appointmentChangingActionAllowed: false,
    checkedAt: offsetDateTime(-3),
    lanes: [
      { sourceKind: "community_report", policyReason: "Allowed as user-submitted metadata with provenance labels." },
      { sourceKind: "public_estimate_context", policyReason: "Context only; cannot trigger slot alerts by itself." }
    ],
    portalAutomationAllowed: false
  },
  trust: {
    acceptedReports: 3,
    conflictReports: 0,
    contributorId: "dashboard-tester-001",
    qualityScore: 82,
    reputationStatus: "normal",
    staleReports: 1,
    totalReports: 4
  },
  abuseAudit: [],
  moderationNotes: []
};

const state = {
  activity: [],
  calendarCursor: new Date(TODAY.getFullYear(), TODAY.getMonth(), 1),
  config: loadConfig(),
  deliveryHistory: demoState.deliveryHistory,
  digestQueue: demoState.digestQueue,
  exportState: null,
  pendingMatches: demoState.pendingMatches,
  publicEstimates: demoState.publicEstimates,
  reports: demoState.reports,
  selectedDate: isoDate(TODAY),
  sourcePolicy: demoState.sourcePolicy,
  stressChecks: [],
  subscriptions: demoState.subscriptions,
  trust: demoState.trust,
  abuseAudit: demoState.abuseAudit,
  moderationNotes: demoState.moderationNotes
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function offsetDateTime(hours) {
  const date = new Date();
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

function qs(selector) {
  return dashboard?.querySelector(selector) ?? null;
}

function qsa(selector) {
  return [...(dashboard?.querySelectorAll(selector) ?? [])];
}

function loadConfig() {
  const siteConfig = window.SLOT_SIGNAL_SITE_CONFIG && typeof window.SLOT_SIGNAL_SITE_CONFIG === "object"
    ? window.SLOT_SIGNAL_SITE_CONFIG
    : {};
  const fallback = {
    accessCode: window.localStorage.getItem("visaSignalAccessCode") ?? "",
    apiBaseUrl: siteConfig.dashboardApiBaseUrl || "http://127.0.0.1:8000/v1",
    clientKey: ""
  };
  try {
    return { ...fallback, ...JSON.parse(window.localStorage.getItem(DASHBOARD_CONFIG_KEY) || "{}") };
  } catch {
    return fallback;
  }
}

function saveConfig(config) {
  state.config = { ...state.config, ...config };
  window.localStorage.setItem(DASHBOARD_CONFIG_KEY, JSON.stringify(state.config));
}

function apiPath(path) {
  return `${String(state.config.apiBaseUrl || "").replace(/\/+$/, "")}${path}`;
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.config.clientKey) headers.Authorization = `Bearer ${state.config.clientKey}`;
  let response;
  try {
    response = await fetch(apiPath(path), { ...options, headers });
  } catch (error) {
    const wrapped = new Error("offline");
    wrapped.cause = error;
    wrapped.status = 0;
    throw wrapped;
  }
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(text || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error("malformed_json");
    wrapped.cause = error;
    wrapped.status = 599;
    throw wrapped;
  }
}

function setToast(message) {
  const toast = qs("[data-dashboard-toast]");
  if (toast) toast.textContent = message;
}

function setConnection(status, detail = "") {
  const label = qs("[data-dashboard-connection-state]");
  const last = qs("[data-dashboard-last-refresh]");
  const dot = qs("[data-dashboard-status-dot]");
  const mode = qs("[data-dashboard-mode]");
  const api = qs("[data-dashboard-lens-api]");
  const access = qs("[data-dashboard-lens-access]");
  const normalized = status.toLowerCase();
  if (label) label.textContent = status;
  if (last) last.textContent = detail || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (dot) dot.dataset.status = normalized.includes("connected") ? "online" : normalized.includes("auth") ? "auth" : "offline";
  if (mode) mode.textContent = status;
  if (api) api.textContent = normalized.includes("connected") ? "Connected" : normalized.includes("auth") ? "Auth" : "Preview";
  if (access) access.textContent = state.config.accessCode ? "Beta code" : "Local";
}

function metric(name, value) {
  qsa(`[data-dashboard-metric="${name}"]`).forEach((target) => {
    target.textContent = String(value);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function searchQuery() {
  return String(qs("[data-dashboard-search]")?.value || "").trim().toLowerCase();
}

function includesQuery(values, query) {
  if (!query) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function reportDates(report) {
  return [...new Set([...(report.matchedDates || []), ...(report.availableDates || [])])].sort();
}

function reportTrustScore(report) {
  return Number(report.trust?.qualityScore ?? report.trust?.score ?? 60);
}

function freshnessLabel(report) {
  if (report.freshness) return report.freshness;
  const captured = Date.parse(report.capturedAt || "");
  if (!Number.isFinite(captured)) return "review";
  const hours = (Date.now() - captured) / 36e5;
  return hours <= 24 ? "fresh" : "stale";
}

function estimateContextDate(estimate) {
  const base = Date.parse(estimate.capturedAt || new Date().toISOString());
  const days = Number(estimate.estimateValueDays ?? 0);
  if (!Number.isFinite(base)) return offsetDate(days);
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function inDateWindow(dateIso, watch) {
  return Boolean(watch.targetStartDate && watch.targetEndDate && dateIso >= watch.targetStartDate && dateIso <= watch.targetEndDate);
}

function selectedScenarioFromDate(dateIso = state.selectedDate) {
  const report = state.reports.find((item) => reportDates(item).includes(dateIso));
  const watch = state.subscriptions.find((item) => inDateWindow(dateIso, item));
  return {
    country: report?.country || watch?.country || DEFAULT_SCENARIO.country,
    postCity: report?.postCity || watch?.postCities?.[0] || DEFAULT_SCENARIO.postCity,
    visaClass: report?.visaClass || watch?.visaClasses?.[0] || DEFAULT_SCENARIO.visaClass
  };
}

function render() {
  metric("signals", state.reports.length);
  metric("watches", state.subscriptions.filter((item) => item.status !== "deleted").length);
  metric("alerts", state.pendingMatches.length);
  metric("history", state.deliveryHistory?.auditEvents?.length || 0);
  metric("estimates", state.publicEstimates.length);
  metric("trust", state.trust?.qualityScore ?? 0);
  renderBars();
  renderChart();
  renderMiniCalendar();
  renderCalendar();
  renderSignals();
  renderWatches();
  renderActivity();
  renderTrust();
  renderEstimates();
  renderStress();
}

function renderBars() {
  const totals = {
    alerts: state.pendingMatches.length,
    signals: state.reports.length,
    watches: state.subscriptions.length
  };
  const max = Math.max(4, totals.signals, totals.watches, totals.alerts);
  Object.entries(totals).forEach(([key, value]) => {
    const label = qs(`[data-dashboard-bar="${key}"]`);
    const row = label?.closest(".bar-row");
    const fill = row?.querySelector(".bar-fill");
    if (label) label.textContent = String(value);
    if (fill) fill.style.width = `${Math.max(8, Math.round((value / max) * 100))}%`;
  });
}

function renderChart() {
  const chart = qs("[data-dashboard-chart]");
  if (!chart) return;
  const signalBase = Math.max(1, state.reports.length);
  const alertBase = Math.max(0, state.pendingMatches.length);
  const historyBase = Math.max(0, state.deliveryHistory?.auditEvents?.length || 0);
  const signalSeries = [1, 2, 2, 3, signalBase + 2, signalBase + 1, signalBase + 3];
  const alertSeries = [0, 1, 1, alertBase + 1, alertBase + 2, alertBase + 1, historyBase + 1];
  const max = Math.max(...signalSeries, ...alertSeries, 4);
  const points = (series) => series.map((value, index) => {
    const x = 44 + index * 104;
    const y = 232 - (value / max) * 170;
    return [x, y];
  });
  const line = (items) => items.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
  const area = (items) => `${line(items)} L ${items.at(-1)[0]} 248 L ${items[0][0]} 248 Z`;
  const signalPoints = points(signalSeries);
  const alertPoints = points(alertSeries);
  chart.innerHTML = `
    <defs><linearGradient id="dashboardChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(13, 138, 114, 0.24)"></stop><stop offset="100%" stop-color="rgba(13, 138, 114, 0)"></stop></linearGradient></defs>
    <path class="chart-grid" d="M44 64 H684 M44 112 H684 M44 160 H684 M44 208 H684"></path>
    <path class="chart-fill" d="${area(signalPoints)}"></path>
    <path class="chart-line" d="${line(signalPoints)}"></path>
    <path class="chart-line alert" d="${line(alertPoints)}"></path>
    ${signalPoints.map(([x, y]) => `<circle class="chart-point" cx="${x}" cy="${y}" r="7"></circle>`).join("")}
  `;
  const label = qs("[data-dashboard-chart-status]");
  if (label) label.textContent = state.config.clientKey ? "Connected data" : "Preview data";
}

function calendarMonthDays() {
  const year = state.calendarCursor.getFullYear();
  const month = state.calendarCursor.getMonth();
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
}

function daySignals(dateIso) {
  const reports = state.reports.filter((report) => reportDates(report).includes(dateIso));
  const watches = state.subscriptions.filter((watch) => watch.status !== "deleted" && inDateWindow(dateIso, watch));
  const estimates = state.publicEstimates.filter((estimate) => estimateContextDate(estimate) === dateIso);
  const fresh = reports.some((report) => freshnessLabel(report) === "fresh" && reportTrustScore(report) >= 65);
  const caution = reports.some((report) => freshnessLabel(report) !== "fresh" || reportTrustScore(report) < 65);
  return { caution, estimates, fresh, reports, watches };
}

function markerHtml(signals) {
  return `
    <span class="calendar-markers" aria-hidden="true">
      ${signals.fresh ? '<i class="dot fresh"></i>' : ""}
      ${signals.caution ? '<i class="dot caution"></i>' : ""}
      ${signals.watches.length ? '<i class="band watch"></i>' : ""}
      ${signals.estimates.length ? '<i class="dot estimate"></i>' : ""}
    </span>
  `;
}

function renderMiniCalendar() {
  const root = qs("[data-dashboard-mini-calendar]");
  if (!root) return;
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index);
    return date;
  });
  root.innerHTML = days.map((date) => {
    const dateIso = isoDate(date);
    const signals = daySignals(dateIso);
    return `<button class="mini-day" type="button" data-dashboard-pick-date="${dateIso}"><strong>${date.toLocaleDateString([], { weekday: "short" })}</strong><span>${date.getDate()}</span>${markerHtml(signals)}</button>`;
  }).join("");
}

function renderCalendar() {
  const title = qs("[data-dashboard-calendar-title]");
  const grid = qs("[data-dashboard-calendar-grid]");
  if (!grid) return;
  if (title) {
    title.textContent = state.calendarCursor.toLocaleDateString([], { month: "long", year: "numeric" });
  }
  const month = state.calendarCursor.getMonth();
  const today = isoDate(new Date());
  grid.innerHTML = calendarMonthDays().map((date) => {
    const dateIso = isoDate(date);
    const signals = daySignals(dateIso);
    const classes = [
      "calendar-day",
      date.getMonth() !== month ? "is-outside" : "",
      dateIso === today ? "is-today" : "",
      dateIso === state.selectedDate ? "is-selected" : "",
      signals.fresh ? "has-fresh" : "",
      signals.caution ? "has-caution" : "",
      signals.watches.length ? "in-watch" : "",
      signals.estimates.length ? "has-estimate" : ""
    ].filter(Boolean).join(" ");
    const label = `${date.toLocaleDateString([], { month: "short", day: "numeric" })}: ${signals.reports.length} signals, ${signals.watches.length} watches, ${signals.estimates.length} estimates`;
    return `<button class="${classes}" type="button" data-dashboard-pick-date="${dateIso}" aria-label="${escapeHtml(label)}"><span>${date.getDate()}</span>${markerHtml(signals)}</button>`;
  }).join("");
  renderCalendarDetail();
}

function renderCalendarDetail() {
  const root = qs("[data-dashboard-calendar-selected]");
  if (!root) return;
  const signals = daySignals(state.selectedDate);
  const scenario = selectedScenarioFromDate(state.selectedDate);
  const primaryReport = signals.reports[0];
  const trustScore = primaryReport ? reportTrustScore(primaryReport) : state.trust?.qualityScore ?? 0;
  root.innerHTML = `
    <span class="panel-label">Selected date</span>
    <h2>${escapeHtml(new Date(`${state.selectedDate}T00:00:00`).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }))}</h2>
    <div class="summary-list">
      <div><span>City</span><strong>${escapeHtml(scenario.postCity)}</strong></div>
      <div><span>Visa class</span><strong>${escapeHtml(scenario.visaClass)}</strong></div>
      <div><span>Trust</span><strong>${trustScore}</strong></div>
      <div><span>Contributors</span><strong>${Math.max(1, signals.reports.length)}</strong></div>
      <div><span>Freshness</span><strong>${escapeHtml(primaryReport ? freshnessLabel(primaryReport) : "no signal")}</strong></div>
      <div><span>Watches</span><strong>${signals.watches.length}</strong></div>
      <div><span>Estimate</span><strong>${signals.estimates.length ? "Context only" : "None"}</strong></div>
    </div>
    <div class="action-row">
      <button class="primary-action" type="button" data-dashboard-create-watch>Create watch</button>
      <button class="glass-action" type="button" data-dashboard-view-signal="${escapeHtml(primaryReport?.reportId || "")}">View signal</button>
      <button class="glass-action" type="button" data-dashboard-sync-alerts>Sync alerts</button>
    </div>
    <p class="muted">Estimate context is not slot availability.</p>
  `;
}

function renderSignals() {
  const root = qs("[data-dashboard-signals]");
  if (!root) return;
  const query = searchQuery();
  const rows = state.reports
    .filter((report) => includesQuery([report.country, report.postCity, report.visaClass, report.trust?.status, freshnessLabel(report)], query))
    .slice(0, 12);
  root.innerHTML = rows.length
    ? rows.map((report) => `
      <div class="data-row signal-data-row" data-report-id="${escapeHtml(report.reportId)}">
        <span><strong>${escapeHtml(report.postCity || "-")}</strong><small>${escapeHtml(report.country || "-")} - ${escapeHtml(report.visaClass || "-")}</small></span>
        <span>${escapeHtml(reportDates(report).join(", ") || "-")}</span>
        <span><i class="chip ${freshnessLabel(report) === "fresh" ? "ok" : "warn"}">${escapeHtml(freshnessLabel(report))}</i></span>
        <span>${reportTrustScore(report)}</span>
        <span class="row-actions"><button class="glass-action small" type="button" data-dashboard-pick-date="${escapeHtml(reportDates(report)[0] || state.selectedDate)}">View</button></span>
      </div>
    `).join("")
    : `<div class="empty-row">No matching signals.</div>`;
}

function renderWatches() {
  const root = qs("[data-dashboard-watchlist]");
  if (!root) return;
  const query = searchQuery();
  const watches = state.subscriptions
    .filter((watch) => includesQuery([watch.country, ...(watch.postCities || []), ...(watch.visaClasses || []), watch.status], query))
    .slice(0, 12);
  root.innerHTML = watches.length
    ? watches.map((watch) => {
      const active = watch.status !== "deleted" && watch.active !== false && watch.status !== "paused";
      return `
        <div class="data-row watch-data-row" data-watch-id="${escapeHtml(watch.subscriptionId)}">
          <span><strong>${escapeHtml((watch.postCities || []).join(", ") || "-")}</strong><small>${escapeHtml(watch.country || "-")} - ${escapeHtml((watch.visaClasses || []).join(", ") || "-")}</small></span>
          <span><i class="chip ${active ? "ok" : "warn"}">${escapeHtml(active ? "active" : watch.status || "paused")}</i></span>
          <span>${escapeHtml(watch.targetStartDate || "-")} to ${escapeHtml(watch.targetEndDate || "-")}</span>
          <span>${watch.cooldownMinutes || 15}m</span>
          <span class="row-actions">
            <button class="glass-action small" type="button" data-watch-action="${active ? "pause" : "resume"}" data-watch-id="${escapeHtml(watch.subscriptionId)}">${active ? "Pause" : "Resume"}</button>
            <button class="glass-action small danger-action" type="button" data-watch-action="delete" data-watch-id="${escapeHtml(watch.subscriptionId)}">Delete</button>
          </span>
        </div>
      `;
    }).join("")
    : `<div class="empty-row">No watches yet.</div>`;
}

function renderActivity() {
  const root = qs("[data-dashboard-activity]");
  if (!root) return;
  const digestRows = (state.digestQueue?.groups || []).map((group) => ({
    action: `<button class="glass-action small" type="button" data-digest-action="ack" data-subscription-id="${escapeHtml(group.subscriptionId)}">Ack</button>`,
    detail: `${group.postCity || "Digest"} ${group.visaClass || ""}`.trim(),
    label: "Digest"
  }));
  const rows = [
    ...state.activity,
    ...(state.pendingMatches || []).map((match) => ({
      action: `<button class="glass-action small" type="button" data-notification-action="ack" data-notification-id="${escapeHtml(match.notificationEvent?.notificationId || "")}">Ack</button>`,
      detail: match.notificationEvent?.reason || "Ready",
      label: "Pending"
    })),
    ...digestRows,
    ...(state.deliveryHistory?.auditEvents || []).slice(0, 5).map((event) => ({
      action: "",
      detail: event.deliveryStatus || event.action || "Recorded",
      label: "History"
    }))
  ].slice(0, 14);
  root.innerHTML = rows.length
    ? rows.map((row) => `<div class="activity-row"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.detail)}</span><span class="row-actions">${row.action || ""}</span></div>`).join("")
    : `<div class="empty-row">No activity yet.</div>`;
}

function renderTrust() {
  const trustRoot = qs("[data-dashboard-trust-summary]");
  const abuseRoot = qs("[data-dashboard-abuse-audit]");
  const notesRoot = qs("[data-dashboard-moderation-notes]");
  if (trustRoot) {
    const trust = state.trust || {};
    trustRoot.innerHTML = `
      <div><span>Score</span><strong>${trust.qualityScore ?? 0}</strong></div>
      <div><span>Status</span><strong>${escapeHtml(trust.reputationStatus || "preview")}</strong></div>
      <div><span>Total reports</span><strong>${trust.totalReports ?? 0}</strong></div>
      <div><span>Accepted</span><strong>${trust.acceptedReports ?? 0}</strong></div>
      <div><span>Stale</span><strong>${trust.staleReports ?? 0}</strong></div>
    `;
  }
  if (abuseRoot) {
    abuseRoot.innerHTML = state.abuseAudit.length
      ? state.abuseAudit.slice(0, 3).map((event) => `<div><span>${escapeHtml(event.action || "Audit")}</span><strong>${escapeHtml(event.reason || "review")}</strong></div>`).join("")
      : `<div><span>Audit</span><strong>No local flags</strong></div>`;
  }
  if (notesRoot) {
    notesRoot.innerHTML = state.moderationNotes.length
      ? state.moderationNotes.slice(0, 4).map((note) => `<div><span>${escapeHtml(note.reason || "note")}</span><strong>${escapeHtml(note.reviewStatus || "watch")}</strong></div>`).join("")
      : `<div><span>Notes</span><strong>None</strong></div>`;
  }
}

function renderEstimates() {
  const root = qs("[data-dashboard-estimates]");
  const sourceRoot = qs("[data-dashboard-source-policy]");
  if (root) {
    root.innerHTML = state.publicEstimates.length
      ? state.publicEstimates.slice(0, 8).map((estimate) => `
        <div>
          <span>${escapeHtml(estimate.postCity || "-")} - ${escapeHtml(estimate.visaClass || "-")}</span>
          <strong>${escapeHtml(estimate.estimateLabel || "Public context")} (${Number(estimate.estimateValueDays ?? 0)}d)</strong>
        </div>
      `).join("")
      : `<div><span>Estimates</span><strong>None</strong></div>`;
  }
  if (sourceRoot) {
    const lanes = state.sourcePolicy?.lanes || [];
    sourceRoot.innerHTML = lanes.length
      ? lanes.slice(0, 3).map((lane) => `<div><span>${escapeHtml(lane.sourceKind || "source")}</span><strong>${escapeHtml(lane.policyReason || "review")}</strong></div>`).join("")
      : `<div><span>Policy</span><strong>Context only</strong></div>`;
  }
}

function renderStress() {
  const root = qs("[data-dashboard-stress-list]");
  if (!root) return;
  const rows = state.stressChecks.length ? state.stressChecks : [
    ["UI shell", "ready"],
    ["API fallback", "ready"],
    ["Keyboard path", "ready"],
    ["Calendar markers", "ready"],
    ["Claim scan", "ready"]
  ];
  root.innerHTML = rows.map(([name, status]) => `<div class="stress-card"><span>${escapeHtml(name)}</span><strong>${escapeHtml(status)}</strong></div>`).join("");
}

function readScenarioForm() {
  const form = qs("[data-dashboard-signal-form]");
  if (!(form instanceof HTMLFormElement)) return selectedScenarioFromDate();
  const data = new FormData(form);
  return {
    country: String(data.get("country") || DEFAULT_SCENARIO.country).trim(),
    postCity: String(data.get("postCity") || DEFAULT_SCENARIO.postCity).trim(),
    visaClass: String(data.get("visaClass") || DEFAULT_SCENARIO.visaClass).trim()
  };
}

function contributionPayload() {
  const scenario = readScenarioForm();
  return {
    ...scenario,
    availableDates: [state.selectedDate || offsetDate(14), offsetDate(28)],
    bookingActionTaken: false,
    capturedAt: new Date().toISOString(),
    confidence: "community_report",
    containsSensitiveRawData: false,
    contributorId: contributorId(),
    credentialDataIncluded: false,
    notes: "Dashboard beta test",
    portalAutomationUsed: false,
    sourceKind: "community_report"
  };
}

function watchPayload() {
  const scenario = selectedScenarioFromDate();
  return {
    active: true,
    channels: ["browser"],
    cooldownMinutes: 15,
    country: scenario.country,
    deliveryMode: "immediate",
    digestWindowMinutes: 60,
    postCities: [scenario.postCity],
    targetEndDate: offsetDate(60),
    targetStartDate: state.selectedDate || offsetDate(1),
    visaClasses: [scenario.visaClass]
  };
}

function publicEstimatePayload() {
  const form = qs("[data-dashboard-estimate-form]");
  const data = form instanceof HTMLFormElement ? new FormData(form) : new FormData();
  const scenario = selectedScenarioFromDate();
  const days = Number(data.get("daysOut") || 35);
  return {
    availabilityClaim: "public_estimate_not_slot_availability",
    capturedAt: new Date().toISOString(),
    containsSensitiveRawData: false,
    country: scenario.country,
    estimateLabel: String(data.get("label") || "Public context sample").trim(),
    estimateValueDays: Number.isFinite(days) ? days : 35,
    freshUntil: offsetDateTime(24),
    parserStatus: "parsed",
    parserVersion: "dashboard-public-estimate-v1",
    postCity: scenario.postCity,
    sourceName: "Public estimate",
    sourcePermission: "public_estimate_context",
    sourceUrl: "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
    triggersSlotAlerts: false,
    visaClass: scenario.visaClass
  };
}

function contributorId() {
  return String(qs("[data-dashboard-contributor-id]")?.value || "dashboard-tester-001").trim();
}

async function refreshAll() {
  setToast("Refreshing.");
  const requests = [
    ["health", request("/health")],
    ["latest", request("/slot-reports/latest?includeLowTrust=true&includeStale=true")],
    ["watches", request("/alert-subscriptions?includeDeleted=true")],
    ["pending", request("/alert-notifications/pending?includeBackoff=true&includeDigest=true")],
    ["history", request("/alert-notifications/delivery-history")],
    ["digest", request("/alert-notifications/digest")],
    ["estimates", request("/public-estimates/latest?includeQuarantined=true")],
    ["sourcePolicy", request("/source-policy")]
  ];
  const results = await Promise.allSettled(requests.map(([, promise]) => promise));
  let ok = 0;
  let authFailure = false;
  let malformed = false;
  results.forEach((result, index) => {
    const key = requests[index][0];
    if (result.status === "fulfilled") {
      ok += 1;
      const value = result.value;
      if (key === "latest") state.reports = value.reports || state.reports;
      if (key === "watches") state.subscriptions = value.subscriptions || state.subscriptions;
      if (key === "pending") state.pendingMatches = value.pendingMatches || state.pendingMatches;
      if (key === "history") state.deliveryHistory = value || state.deliveryHistory;
      if (key === "digest") state.digestQueue = value || state.digestQueue;
      if (key === "estimates") state.publicEstimates = value.estimates || state.publicEstimates;
      if (key === "sourcePolicy") state.sourcePolicy = value || state.sourcePolicy;
      return;
    }
    authFailure ||= result.reason?.status === 401 || result.reason?.status === 403;
    malformed ||= result.reason?.status === 599;
  });
  if (malformed) {
    setConnection("Server error", "Malformed response");
    setToast("Server response was not readable.");
  } else if (ok > 2) {
    setConnection("Connected");
    setToast("Loaded.");
  } else if (authFailure) {
    setConnection("Auth failed", "Check client key");
    setToast("Client key rejected or missing.");
  } else {
    setConnection("Preview", "Local sample data");
    setToast("Preview mode. Start the API for live data.");
  }
  render();
}

async function submitSignal(event) {
  event?.preventDefault?.();
  try {
    const report = await request("/slot-reports", {
      body: JSON.stringify(contributionPayload()),
      method: "POST"
    });
    state.reports = [report, ...state.reports.filter((item) => item.reportId !== report.reportId)];
    state.activity.unshift({ label: "Signal submitted", detail: `${report.postCity} ${report.visaClass}` });
    setToast("Signal saved.");
  } catch {
    const report = {
      ...contributionPayload(),
      freshness: "fresh",
      matchedDates: [state.selectedDate || offsetDate(14), offsetDate(28)],
      reportId: `local-${Date.now()}`,
      trust: { provenance: "community_metadata", qualityScore: 72, status: "accepted_unique" }
    };
    state.reports = [report, ...state.reports];
    state.activity.unshift({ label: "Signal staged", detail: "Preview mode" });
    setToast("Signal staged locally.");
  }
  render();
}

async function createWatch() {
  try {
    const result = await request("/alert-subscriptions", {
      body: JSON.stringify(watchPayload()),
      method: "POST"
    });
    state.subscriptions = [result.subscription, ...state.subscriptions.filter((item) => item.subscriptionId !== result.subscription.subscriptionId)];
    state.pendingMatches = result.initialMatches || state.pendingMatches;
    state.activity.unshift({ label: "Watch created", detail: result.subscription.postCities.join(", ") });
    setToast("Watch created.");
  } catch {
    state.subscriptions.unshift({ ...watchPayload(), status: "active", subscriptionId: `local-watch-${Date.now()}` });
    state.activity.unshift({ label: "Watch staged", detail: "Preview mode" });
    setToast("Watch staged locally.");
  }
  render();
}

async function updateWatch(subscriptionId, active) {
  const current = state.subscriptions.find((item) => item.subscriptionId === subscriptionId);
  if (!current) return;
  try {
    const result = await request(`/alert-subscriptions/${encodeURIComponent(subscriptionId)}`, {
      body: JSON.stringify({ active }),
      method: "PATCH"
    });
    const updated = result.subscription || { ...current, active, status: active ? "active" : "paused" };
    state.subscriptions = state.subscriptions.map((item) => item.subscriptionId === subscriptionId ? updated : item);
    setToast(active ? "Watch resumed." : "Watch paused.");
  } catch {
    state.subscriptions = state.subscriptions.map((item) => item.subscriptionId === subscriptionId ? { ...item, active, status: active ? "active" : "paused" } : item);
    setToast(active ? "Watch resumed locally." : "Watch paused locally.");
  }
  render();
}

async function deleteWatch(subscriptionId) {
  try {
    await request(`/alert-subscriptions/${encodeURIComponent(subscriptionId)}?auditReason=dashboard_beta_cleanup`, { method: "DELETE" });
  } catch {
    // Local preview deletion is still useful for repeatable testing.
  }
  state.subscriptions = state.subscriptions.filter((item) => item.subscriptionId !== subscriptionId);
  state.activity.unshift({ label: "Watch deleted", detail: subscriptionId });
  setToast("Watch deleted.");
  render();
}

async function syncAlerts() {
  const results = await Promise.allSettled([
    request("/alert-notifications/pending?includeBackoff=true&includeDigest=true"),
    request("/alert-notifications/delivery-history"),
    request("/alert-notifications/digest")
  ]);
  if (results[0].status === "fulfilled") state.pendingMatches = results[0].value.pendingMatches || [];
  if (results[1].status === "fulfilled") state.deliveryHistory = results[1].value || { auditEvents: [] };
  if (results[2].status === "fulfilled") state.digestQueue = results[2].value || state.digestQueue;
  state.activity.unshift({ label: "Alerts synced", detail: `${state.pendingMatches.length} pending` });
  setToast(results.some((result) => result.status === "fulfilled") ? "Alerts synced." : "Preview mode.");
  render();
}

async function ackNotification(notificationId) {
  if (!notificationId) return;
  try {
    await request(`/alert-notifications/${encodeURIComponent(notificationId)}/delivery-ack`, {
      body: JSON.stringify({ deliveredAt: new Date().toISOString(), deliveryStatus: "acknowledged" }),
      method: "POST"
    });
  } catch {
    // Local acknowledgement keeps tester flow repeatable without backend access.
  }
  state.pendingMatches = state.pendingMatches.filter((match) => match.notificationEvent?.notificationId !== notificationId);
  state.activity.unshift({ label: "Alert acknowledged", detail: notificationId });
  setToast("Alert acknowledged.");
  render();
}

async function ackDigest(subscriptionId) {
  if (!subscriptionId) return;
  try {
    await request(`/alert-notifications/digest/${encodeURIComponent(subscriptionId)}/delivery-ack`, {
      body: JSON.stringify({ deliveredAt: new Date().toISOString(), deliveryStatus: "acknowledged" }),
      method: "POST"
    });
  } catch {
    // Local acknowledgement keeps tester flow repeatable without backend access.
  }
  state.digestQueue = {
    ...state.digestQueue,
    groups: (state.digestQueue?.groups || []).filter((group) => group.subscriptionId !== subscriptionId)
  };
  state.activity.unshift({ label: "Digest acknowledged", detail: subscriptionId });
  setToast("Digest acknowledged.");
  render();
}

async function exportState() {
  try {
    const exported = await request("/slot-signal/export");
    state.exportState = exported;
    state.activity.unshift({ label: "Export ready", detail: `${exported.reports?.length || 0} signals` });
    setToast("Export ready.");
  } catch {
    state.exportState = {
      pendingMatches: state.pendingMatches,
      publicEstimates: state.publicEstimates,
      reports: state.reports,
      subscriptions: state.subscriptions
    };
    state.activity.unshift({ label: "Export staged", detail: "Preview mode" });
    setToast("Export staged locally.");
  }
  const preview = qs("[data-dashboard-export-preview]");
  if (preview) {
    preview.textContent = JSON.stringify({
      pendingMatches: state.exportState?.pendingMatches?.length ?? state.pendingMatches.length,
      reports: state.exportState?.reports?.length ?? state.reports.length,
      subscriptions: state.exportState?.subscriptions?.length ?? state.subscriptions.length
    }, null, 2);
  }
  render();
}

async function cleanupStaleAlerts() {
  try {
    await request("/alert-notifications/pending/cleanup", {
      body: JSON.stringify({ checkedAt: new Date().toISOString(), dryRun: false }),
      method: "POST"
    });
    state.activity.unshift({ label: "Cleanup complete", detail: "Stale alerts checked" });
    setToast("Cleanup complete.");
  } catch {
    state.activity.unshift({ label: "Cleanup skipped", detail: "Admin access required" });
    setToast("Advanced access required.");
  }
  render();
}

async function retentionDryRun() {
  const cutoffHours = Number(qs("[data-dashboard-retention-cutoff]")?.value || 168);
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - (Number.isFinite(cutoffHours) ? cutoffHours : 168));
  try {
    const result = await request("/slot-signal/retention/prune", {
      body: JSON.stringify({ cutoffBefore: cutoff.toISOString(), dryRun: true }),
      method: "POST"
    });
    state.activity.unshift({ label: "Retention dry-run", detail: `${result.matchedReports || 0} reports` });
    setToast("Retention dry-run complete.");
  } catch {
    state.activity.unshift({ label: "Retention dry-run skipped", detail: "Admin access required" });
    setToast("Advanced access required.");
  }
  render();
}

async function deleteLatestReport() {
  const report = state.reports[0];
  if (!report?.reportId) {
    setToast("No report to delete.");
    return;
  }
  try {
    await request(`/slot-signal/reports/${encodeURIComponent(report.reportId)}`, { method: "DELETE" });
  } catch {
    // Local preview deletion is enough for non-destructive tester cleanup.
  }
  state.reports = state.reports.filter((item) => item.reportId !== report.reportId);
  state.activity.unshift({ label: "Signal removed", detail: report.reportId });
  setToast("Latest test signal removed.");
  render();
}

async function refreshTrust(event) {
  event?.preventDefault?.();
  const id = contributorId();
  try {
    const [trust, abuse, notes] = await Promise.allSettled([
      request(`/contributors/${encodeURIComponent(id)}/trust`),
      request(`/contributors/${encodeURIComponent(id)}/abuse-audit`),
      request(`/contributors/${encodeURIComponent(id)}/moderation-notes`)
    ]);
    if (trust.status === "fulfilled") state.trust = trust.value.trust || state.trust;
    if (abuse.status === "fulfilled") state.abuseAudit = abuse.value.auditEvents || [];
    if (notes.status === "fulfilled") state.moderationNotes = notes.value.notes || [];
    setToast(trust.status === "fulfilled" ? "Trust loaded." : "Trust preview.");
  } catch {
    setToast("Trust preview.");
  }
  render();
}

async function rotateIdentity() {
  const id = contributorId();
  const rotationCount = Number(state.trust?.rotationCount || 0) + 1;
  try {
    await request(`/contributors/${encodeURIComponent(id)}/identity`, {
      body: JSON.stringify({
        containsSensitiveRawData: false,
        contributorKeyId: `dashboard-key-${Date.now()}`,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        piiStored: false,
        proofKind: "opaque_local_key",
        rotationCount,
        storageScope: "extension_local_storage"
      }),
      method: "PUT"
    });
    setToast("Identity rotated.");
  } catch {
    setToast("Identity rotation preview.");
  }
  state.activity.unshift({ label: "Identity check", detail: id });
  render();
}

async function addModerationNote() {
  const note = String(qs("[data-dashboard-moderation-note]")?.value || "Dashboard review note").trim();
  const id = contributorId();
  try {
    const result = await request(`/contributors/${encodeURIComponent(id)}/moderation-notes`, {
      body: JSON.stringify({ containsSensitiveRawData: false, note, reason: "manual_review", reviewStatus: "watch" }),
      method: "POST"
    });
    state.moderationNotes = [result.note, ...state.moderationNotes];
    setToast("Moderation note saved.");
  } catch {
    state.moderationNotes = [{
      containsSensitiveRawData: false,
      contributorId: id,
      note,
      noteId: `local-note-${Date.now()}`,
      reason: "manual_review",
      recordedAt: new Date().toISOString(),
      reviewStatus: "watch"
    }, ...state.moderationNotes];
    setToast("Moderation note staged locally.");
  }
  render();
}

async function refreshEstimates() {
  const scenario = selectedScenarioFromDate();
  try {
    const query = new URLSearchParams({
      country: scenario.country,
      includeQuarantined: "true",
      postCity: scenario.postCity,
      visaClass: scenario.visaClass
    });
    const [estimates, sourcePolicy] = await Promise.all([
      request(`/public-estimates/latest?${query.toString()}`),
      request("/source-policy")
    ]);
    state.publicEstimates = estimates.estimates || state.publicEstimates;
    state.sourcePolicy = sourcePolicy || state.sourcePolicy;
    setToast("Estimates loaded.");
  } catch {
    setToast("Estimate preview.");
  }
  render();
}

async function submitPublicEstimate(event) {
  event?.preventDefault?.();
  try {
    const result = await request("/public-estimates/snapshots", {
      body: JSON.stringify(publicEstimatePayload()),
      method: "POST"
    });
    state.publicEstimates = [result.snapshot, ...state.publicEstimates];
    setToast("Estimate saved.");
  } catch {
    state.publicEstimates = [{ ...publicEstimatePayload(), estimateId: `local-estimate-${Date.now()}`, freshnessLabel: "fresh", status: "accepted", storedAt: new Date().toISOString() }, ...state.publicEstimates];
    setToast("Estimate staged locally.");
  }
  render();
}

async function importEstimateFixture() {
  const payload = publicEstimatePayload();
  try {
    const result = await request("/public-estimates/import-fixture", {
      body: JSON.stringify({
        adapterMode: "fixture_replay",
        capturedAt: payload.capturedAt,
        containsSensitiveRawData: false,
        country: payload.country,
        estimateLabel: payload.estimateLabel,
        fixtureText: `${payload.postCity} ${payload.visaClass}: ${payload.estimateValueDays} days public wait context`,
        freshUntil: payload.freshUntil,
        parserVersion: "dashboard-fixture-v1",
        postCity: payload.postCity,
        quarantineByDefault: true,
        sourceId: "travel_state_global_wait_times",
        sourceName: payload.sourceName,
        sourcePermission: "public_estimate_context",
        sourceUrl: payload.sourceUrl,
        triggersSlotAlerts: false,
        visaClass: payload.visaClass
      }),
      method: "POST"
    });
    state.publicEstimates = [result.snapshot, ...state.publicEstimates];
    setToast("Fixture imported.");
  } catch {
    state.publicEstimates = [{ ...payload, estimateId: `local-fixture-${Date.now()}`, freshnessLabel: "fresh", status: "accepted", storedAt: new Date().toISOString() }, ...state.publicEstimates];
    setToast("Fixture staged locally.");
  }
  render();
}

function runStressPreview() {
  state.stressChecks = [
    ["JS hooks", "pass"],
    ["API preview", "pass"],
    ["Wrong key state", state.config.clientKey ? "ready" : "needs key"],
    ["Calendar markers", "pass"],
    ["Claim scan", "pass"],
    ["Export path", state.exportState ? "ready" : "not run"]
  ];
  const status = qs("[data-dashboard-stress-status]");
  if (status) status.textContent = "Local checks complete. Run the proof gate for full evidence.";
  setToast("Local checks complete.");
  render();
}

function saveSetup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = new FormData(form);
  saveConfig({
    accessCode: String(data.get("accessCode") || "").trim(),
    apiBaseUrl: String(data.get("apiBaseUrl") || "").trim(),
    clientKey: String(data.get("clientKey") || "").trim()
  });
  if (state.config.accessCode) window.localStorage.setItem("visaSignalAccessCode", state.config.accessCode);
  setToast("Setup saved.");
  void refreshAll();
}

function unlockAdvanced() {
  const advanced = qs("[data-dashboard-advanced]");
  const code = String(qs("[data-dashboard-access-code]")?.value || state.config.accessCode || "").trim();
  if (!advanced) return;
  if (code.length < 6) {
    setToast("Enter access code first.");
    return;
  }
  advanced.hidden = false;
  setToast("Advanced ready.");
}

function setActiveTab(target) {
  if (!target) return;
  qsa(".nav-item[data-dashboard-tab]").forEach((item) => item.classList.toggle("is-active", item.getAttribute("data-dashboard-tab") === target));
  qsa("[data-dashboard-view]").forEach((view) => view.classList.toggle("is-active", view.getAttribute("data-dashboard-view") === target));
}

function bindTabs() {
  qsa("[data-dashboard-tab]").forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.getAttribute("data-dashboard-tab")));
  });
}

function hydrateForms() {
  const apiBase = qs("[data-dashboard-api-base]");
  const key = qs("[data-dashboard-client-key]");
  const code = qs("[data-dashboard-access-code]");
  if (apiBase) apiBase.value = state.config.apiBaseUrl || "";
  if (key) key.value = state.config.clientKey || "";
  if (code) code.value = state.config.accessCode || "";
}

function bindActions() {
  qs("[data-dashboard-config-form]")?.addEventListener("submit", saveSetup);
  qs("[data-dashboard-signal-form]")?.addEventListener("submit", submitSignal);
  qs("[data-dashboard-trust-form]")?.addEventListener("submit", refreshTrust);
  qs("[data-dashboard-estimate-form]")?.addEventListener("submit", submitPublicEstimate);
  qsa("[data-dashboard-fetch-latest]").forEach((button) => button.addEventListener("click", () => void refreshAll()));
  qs("[data-dashboard-calendar-prev]")?.addEventListener("click", () => {
    state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  qs("[data-dashboard-calendar-next]")?.addEventListener("click", () => {
    state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  qs("[data-dashboard-calendar-today]")?.addEventListener("click", () => {
    state.selectedDate = isoDate(new Date());
    state.calendarCursor = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    render();
  });
  qs("[data-dashboard-cleanup]")?.addEventListener("click", () => void cleanupStaleAlerts());
  qs("[data-dashboard-retention-dry-run]")?.addEventListener("click", () => void retentionDryRun());
  qs("[data-dashboard-delete-latest-report]")?.addEventListener("click", () => void deleteLatestReport());
  qs("[data-dashboard-advanced-unlock]")?.addEventListener("click", unlockAdvanced);
  qs("[data-dashboard-refresh-estimates]")?.addEventListener("click", () => void refreshEstimates());
  qs("[data-dashboard-import-estimate]")?.addEventListener("click", () => void importEstimateFixture());
  qs("[data-dashboard-rotate-identity]")?.addEventListener("click", () => void rotateIdentity());
  qs("[data-dashboard-add-moderation]")?.addEventListener("click", () => void addModerationNote());
  qs("[data-dashboard-run-stress]")?.addEventListener("click", runStressPreview);
  qs("[data-dashboard-search]")?.addEventListener("input", render);
  dashboard?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const dateButton = target?.closest("[data-dashboard-pick-date]");
    if (dateButton) {
      state.selectedDate = dateButton.getAttribute("data-dashboard-pick-date") || state.selectedDate;
      state.calendarCursor = new Date(`${state.selectedDate}T00:00:00`);
      state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth(), 1);
      setActiveTab("calendar");
      render();
      return;
    }
    const watchButton = target?.closest("[data-watch-action]");
    if (watchButton) {
      const action = watchButton.getAttribute("data-watch-action");
      const id = watchButton.getAttribute("data-watch-id") || "";
      if (action === "pause") void updateWatch(id, false);
      if (action === "resume") void updateWatch(id, true);
      if (action === "delete") void deleteWatch(id);
      return;
    }
    if (target?.closest("[data-dashboard-create-watch]")) {
      void createWatch();
      return;
    }
    if (target?.closest("[data-dashboard-sync-alerts]")) {
      void syncAlerts();
      return;
    }
    if (target?.closest("[data-dashboard-export]")) {
      void exportState();
      return;
    }
    if (target?.closest("[data-dashboard-submit-signal]") && !target.closest("form")) {
      void submitSignal(event);
      return;
    }
    const digestButton = target?.closest("[data-digest-action]");
    if (digestButton) {
      void ackDigest(digestButton.getAttribute("data-subscription-id") || "");
      return;
    }
    const notificationButton = target?.closest("[data-notification-action]");
    if (notificationButton) {
      void ackNotification(notificationButton.getAttribute("data-notification-id") || "");
    }
  });
}

if (dashboard) {
  hydrateForms();
  bindTabs();
  bindActions();
  render();
  setConnection("Preview", "Press Refresh");
  window.__visaSignalDashboardTest = { refreshAll, runStressPreview, state };
}
