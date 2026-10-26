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
  return <div className={cn("animate-pulse rounded bg-hover", className)} />;
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";
const tones: Record<Tone, string> = {
  neutral: "bg-subtle text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-accent-line",
  ok: "bg-ok-soft text-ok border-ok/15",
  warn: "bg-warn-soft text-warn border-warn/15",
  bad: "bg-bad-soft text-bad border-bad/15",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

const statusStyle: Record<ServerStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-ok", text: "text-ok" },
  unreachable: { label: "Unreachable", dot: "bg-bad", text: "text-bad" },
  disabled: { label: "Disabled", dot: "bg-faint", text: "text-muted" },
  unknown: { label: "Checking", dot: "bg-warn", text: "text-warn" },
};

export function StatusBadge({ status, className }: { status: ServerStatus; className?: string }) {
  const s = statusStyle[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", s.text, className)}>
      <span className={cn("size-1.5 rounded-full", s.dot, status === "unreachable" && "ring-3 ring-bad/15")} />
      {s.label}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-lg border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-line bg-subtle text-muted [&_svg]:size-4.5">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-bad/20 bg-bad-soft px-4 py-3 text-[13px] text-bad">
      <span>{error instanceof Error ? error.message : "Something went wrong"}</span>
      {onRetry && (
        <button onClick={onRetry} className="font-medium underline underline-offset-2">
          Retry
        </button>
      )}
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 text-[12px] font-medium text-ink-2 hover:bg-subtle [&_svg]:size-3.5",
        className,
      )}
      aria-label={label}
    >
      {copied ? <Check className="text-ok" /> : <Copy />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeLine({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md border border-line bg-subtle py-1 pr-1 pl-3", className)}>
      <code className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{value}</code>
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
      className="relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[15px]" />
    </SwitchPrimitive.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-subtle px-1 py-px text-2xs text-muted">{children}</kbd>;
}

/** Definition list row used in detail panels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}
