import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { CheckCircle2, ExternalLink, FileCheck2, Lock, ShieldCheck, UserCheck } from "lucide-react";
import type { BookingAssistSession } from "@slot-signal/contracts";
import type { Tone } from "../shared/status";
import type { TrustCenterLink } from "../shared/trust";

type ToneProps = {
  tone?: Tone;
};

type IconProps = {
  icon: LucideIcon;
};

export function StatusPill({ icon: Icon, label, tone = "neutral" }: IconProps & ToneProps & { label: string }) {
  return (
    <span className="status-pill" data-tone={tone}>
      <Icon className="icon" />
      {label}
    </span>
  );
}

export function GlassPanel({
  children,
  className = "",
  ariaLabel
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={`glass-panel ${className}`.trim()} aria-label={ariaLabel}>
      {children}
    </section>
  );
}

export function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral"
}: IconProps &
  ToneProps & {
    label: string;
    value: string;
    detail: string;
  }) {
  return (
    <article className="metric-tile" data-tone={tone}>
      <Icon className="icon" />
      <strong>{value}</strong>
      <span>{label}</span>
      <p>{detail}</p>
    </article>
  );
}

export function CandidateTimeline({
  items
}: {
  items: Array<IconProps & ToneProps & { title: string; meta: string; detail: string }>;
}) {
  return (
    <div className="timeline-list">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <article className="timeline-card" data-tone={item.tone ?? "neutral"} key={item.title}>
            <span className="timeline-marker">
              <Icon className="icon" />
            </span>
            <div>
              <div className="row compact-row">
                <h3>{item.title}</h3>
                <span>{item.meta}</span>
              </div>
              <p>{item.detail}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function CooldownBanner({
  icon: Icon,
  title,
  value,
  detail,
  tone = "warning"
}: IconProps & ToneProps & { title: string; value: string; detail: string }) {
  return (
    <section className="cooldown-banner" data-tone={tone} aria-label={title}>
      <Icon className="icon" />
      <div>
        <span>{title}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </section>
  );
}

export function PermissionNotice() {
  return (
    <section className="permission-notice" aria-label="Permission status">
      <Lock className="icon" />
      <div>
        <strong>AIS access is optional</strong>
        <p>Portal permission is requested only when live mode is explicitly enabled.</p>
      </div>
    </section>
  );
}

export function BookingAssistPreview({ session }: { session?: BookingAssistSession | null }) {
  return (
    <section className="assist-card" aria-label="Booking assist boundary">
      <div className="assist-step" data-state="ready">
        <CheckCircle2 className="icon" />
        <span>Detect candidate</span>
      </div>
      <div className="assist-step" data-state="ready">
        <ExternalLink className="icon" />
        <span>Open official page</span>
      </div>
      <div className="assist-step" data-state="locked">
        <UserCheck className="icon" />
        <span>User confirms</span>
      </div>
      {session ? (
        <dl className="assist-meta" aria-label="Prepared booking assist session">
          <div>
            <dt>Session</dt>
            <dd>{session.sessionId}</dd>
          </div>
          <div>
            <dt>Final authority</dt>
            <dd>{session.finalConfirmationAuthority.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Auto submit</dt>
            <dd>{session.autoSubmitAllowed ? "allowed" : "blocked"}</dd>
          </div>
        </dl>
      ) : null}
      <p>Appointment-changing confirmation stays visible and user-performed.</p>
    </section>
  );
}

export function NotificationChannelList({
  channels
}: {
  channels: Array<IconProps & ToneProps & { name: string; status: string; detail: string }>;
}) {
  return (
    <div className="channel-list">
      {channels.map((channel) => {
        const Icon = channel.icon;
        return (
          <article className="channel-row" data-tone={channel.tone ?? "neutral"} key={channel.name}>
            <Icon className="icon" />
            <div>
              <strong>{channel.name}</strong>
              <p>{channel.detail}</p>
            </div>
            <span>{channel.status}</span>
          </article>
        );
      })}
    </div>
  );
}

export function CheckPolicyControl({
  minimumIntervalMinutes,
  mode,
  liveChecks,
  retryBehavior
}: {
  minimumIntervalMinutes: number;
  mode: string;
  liveChecks: string;
  retryBehavior: string;
}) {
  return (
    <div className="policy-control">
      <div className="setting">
        <label htmlFor="check-interval">Minimum interval</label>
        <input id="check-interval" readOnly value={`${minimumIntervalMinutes} minutes`} />
      </div>
      <div className="segmented" aria-label="Adapter mode">
        <span data-active="true">{mode}</span>
        <span>Live locked</span>
      </div>
      <div className="policy-grid">
        <span>
          <ShieldCheck className="icon" />
          Live checks: {liveChecks}
        </span>
        <span>
          <ShieldCheck className="icon" />
          Retry: {retryBehavior}
        </span>
      </div>
    </div>
  );
}

export function TrustCenterLinks({
  links
}: {
  links: Array<TrustCenterLink & { href: string }>;
}) {
  return (
    <div className="trust-link-grid" aria-label="Slot Signal Trust Center">
      {links.map((link) => {
        return (
          <a className="trust-link" href={link.href} key={link.id} rel="noreferrer" target="_blank">
            <FileCheck2 className="icon" />
            <span>
              <strong>{link.label}</strong>
              <small>{link.summary}</small>
            </span>
            <em>{link.status.replace("-", " ")}</em>
          </a>
        );
      })}
    </div>
  );
}
