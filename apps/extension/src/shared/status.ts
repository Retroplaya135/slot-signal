import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Database,
  Lock,
  Mail,
  MapPin,
  MessageCircle,
  Radio,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  UserCheck,
  WifiOff
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type TrackerMode = "ready" | "watching" | "cooldown" | "permission_needed";
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "action";

export type StatusModel = {
  mode: TrackerMode;
  label: string;
  detail: string;
  lastCheck: string;
  nextCheck: string;
  icon: LucideIcon;
  tone: Tone;
};

export const statusModel: StatusModel = {
  mode: "ready",
  label: "Signal ready",
  detail: "Community signal checks are ready. Live portal automation is off.",
  lastCheck: "Not run",
  nextCheck: "Manual check",
  icon: ShieldCheck,
  tone: "success"
};

export const dashboardStats = [
  {
    label: "Check policy",
    value: "15 min",
    detail: "Minimum scheduled interval",
    icon: Clock3,
    tone: "warning" as const
  },
  {
    label: "Booking boundary",
    value: "Manual",
    detail: "Final confirmation is user-performed",
    icon: UserCheck,
    tone: "action" as const
  },
  {
    label: "Notifications",
    value: "Local",
    detail: "Browser/digest active; providers outbox-gated",
    icon: Bell,
    tone: "info" as const
  },
  {
    label: "Portal mode",
    value: "Manual",
    detail: "No live AIS calls",
    icon: CalendarClock,
    tone: "success" as const
  }
];

export const watchedLocations = [
  {
    city: "Toronto",
    country: "Canada",
    service: "Visitor visa",
    status: "Watching draft",
    detail: "Community signal window only",
    tone: "info" as const,
    icon: MapPin
  },
  {
    city: "Vancouver",
    country: "Canada",
    service: "Visitor visa",
    status: "Permission pending",
    detail: "Optional AIS host access is not requested yet",
    tone: "warning" as const,
    icon: Lock
  }
];

export const candidateTimeline = [
  {
    title: "No candidate slots",
    meta: "Fixture stream empty",
    detail: "Community reports and fixture proofs feed the local matching queue.",
    tone: "neutral" as const,
    icon: CalendarClock
  },
  {
    title: "Booking assist boundary",
    meta: "Official portal",
    detail: "The assistant can prepare context; the user confirms appointment changes.",
    tone: "action" as const,
    icon: UserCheck
  }
];

export const cooldownState = {
  title: "Cooldown policy armed",
  value: "15 min minimum",
  detail: "403, 429, and empty responses cool down instead of retrying faster.",
  tone: "warning" as const,
  icon: TimerReset
};

export const notificationChannels = [
  {
    name: "Browser",
    status: "Fixture ready",
    detail: "Local alert after safe fixture event",
    tone: "info" as const,
    icon: Bell
  },
  {
    name: "Telegram",
    status: "Outbox gated",
    detail: "Provider disabled by default",
    tone: "warning" as const,
    icon: MessageCircle
  },
  {
    name: "Email",
    status: "Outbox gated",
    detail: "No external delivery",
    tone: "neutral" as const,
    icon: Mail
  },
  {
    name: "Slack",
    status: "Outbox gated",
    detail: "No webhook delivery",
    tone: "neutral" as const,
    icon: Radio
  }
];

export const runtimeStates = [
  {
    label: "Backend",
    value: "Local API",
    detail: "Durable slot-signal store",
    tone: "info" as const,
    icon: Database
  },
  {
    label: "Live adapter",
    value: "Disabled",
    detail: "Review gate required",
    tone: "warning" as const,
    icon: WifiOff
  },
  {
    label: "Audit trail",
    value: "Durable",
    detail: "Delivery and outbox histories",
    tone: "success" as const,
    icon: Radio
  }
];

export const stageWarnings = [
  {
    title: "No live portal calls",
    detail: "The extension does not read credentials, cookies, or private pages.",
    icon: AlertTriangle,
    tone: "warning" as const
  },
  {
    title: "Human confirmation required",
    detail: "Booking assist can open context later, but cannot finalize changes.",
    icon: ShieldCheck,
    tone: "success" as const
  },
  {
    title: "Manual check only",
    detail: "Scheduled live checks remain disabled until policy and consent gates pass.",
    icon: RefreshCw,
    tone: "info" as const
  }
];

export const checkPolicy = {
  minimumIntervalMinutes: 15,
  mode: "Fixture only",
  liveChecks: "Off",
  retryBehavior: "Cooldown first"
};
