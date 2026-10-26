import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ServerStatus } from "@/lib/api";
import { cn } from "@/lib/format";

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin size-4", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-subtle", className)} />;
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";
const tones: Record<Tone, string> = {
  neutral: "text-slate-600 bg-slate-100",
  accent: "text-blue-700 bg-blue-50",
  ok: "text-emerald-700 bg-emerald-50",
  warn: "text-amber-700 bg-amber-50",
  bad: "text-red-700 bg-red-50",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

const statusStyle: Record<ServerStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-700 bg-emerald-50" },
  unreachable: { label: "Unreachable", dot: "bg-red-500", text: "text-red-700 bg-red-50" },
  disabled: { label: "Disabled", dot: "bg-slate-400", text: "text-slate-600 bg-slate-100" },
  unknown: { label: "Checking", dot: "bg-amber-500", text: "text-amber-700 bg-amber-50" },
};

export function StatusDot({ status, className }: { status: ServerStatus; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {status === "unreachable" && <span className="absolute inset-0 animate-ping rounded-full bg-bad/40" />}
      <span className={cn("relative size-2 rounded-full", statusStyle[status].dot)} />
    </span>
  );
}

export function StatusBadge({ status, className }: { status: ServerStatus; className?: string }) {
  const s = statusStyle[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap", s.text, className)}>
      <StatusDot status={status} className="size-1.5 [&>span]:size-1.5" />
      {s.label}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Section title used outside cards (Overview, detail pages). */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-[16px] font-bold text-ink">{children}</h2>
      {aside && <div className="text-[13px] text-muted">{aside}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[24px] leading-8 font-bold tracking-[-0.02em] text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[14px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-slate-100 text-slate-400 [&_svg]:size-7">{icon}</div>}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-bad/20 bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
      <span>{error instanceof Error ? error.message : "Something went wrong"}</span>
      {onRetry && (
        <button onClick={onRetry} className="font-medium underline underline-offset-2">
          Retry
        </button>
      )}
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className, iconOnly }: { value: string; label?: string; className?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className={cn(
        "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-[5px] border border-line-strong bg-surface px-2 text-[12px] font-medium text-ink-2 hover:bg-subtle [&_svg]:size-3.5",
        iconOnly && "w-6.5 justify-center px-0",
        className,
      )}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="text-ok" /> : <Copy />}
      {!iconOnly && (copied ? "Copied" : label)}
    </button>
  );
}

export function CodeLine({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md border border-line bg-subtle/70 py-1 pr-1 pl-2.5", className)}>
      <code className="min-w-0 flex-1 truncate text-[12px] text-ink">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-slate-300 transition-colors data-[state=checked]:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface px-1 text-2xs text-muted">{children}</kbd>;
}

/** Definition list row used in detail panels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-2 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

const tileGradients = {
  blue: "from-blue-500 to-blue-600 shadow-blue-500/30",
  indigo: "from-indigo-500 to-purple-600 shadow-indigo-500/30",
  emerald: "from-emerald-500 to-emerald-600 shadow-emerald-500/30",
  amber: "from-amber-400 to-orange-500 shadow-orange-500/30",
  rose: "from-rose-500 to-red-600 shadow-red-500/30",
  slate: "from-slate-600 to-slate-800 shadow-slate-600/30",
} as const;
export type TileColor = keyof typeof tileGradients;

/** Gradient icon tile used for metrics, servers and stores. */
export function IconTile({ color = "blue", size = "md", children, className }: { color?: TileColor; size?: "sm" | "md" | "lg"; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center bg-gradient-to-br text-white shadow-lg",
        size === "sm" && "size-9 rounded-xl [&_svg]:size-4",
        size === "md" && "size-12 rounded-2xl [&_svg]:size-6",
        size === "lg" && "size-16 rounded-2xl [&_svg]:size-8",
        tileGradients[color],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Thin progress bar for real ratios (e.g. servers online / total). */
export function Meter({ value, color = "bg-blue-600" }: { value: number; color?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cn("h-2 rounded-full transition-all duration-500", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
