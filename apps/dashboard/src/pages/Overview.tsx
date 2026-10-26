import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, CheckCircle2, Clock3, PlugZap, ServerCog, ShieldAlert, Store, Wrench } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { CopyButton, EmptyState, ErrorState, IconTile, Meter, Skeleton, StatusBadge, type TileColor } from "@/components/ui/misc";
import { api, type AuditItem, type Overview } from "@/lib/api";
import { useAuth, useMeta } from "@/lib/auth";
import { cn, dateTime, duration, percent, relativeTime } from "@/lib/format";

export function OutcomeDot({ outcome }: { outcome: AuditItem["outcome"] }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", outcome === "success" ? "bg-emerald-500" : outcome === "denied" ? "bg-amber-500" : "bg-red-500")} />;
}

const outcomeBadge: Record<AuditItem["outcome"], string> = {
  success: "bg-emerald-50 text-emerald-700",
  error: "bg-red-50 text-red-700",
  denied: "bg-amber-50 text-amber-700",
};

const serverColors: TileColor[] = ["blue", "emerald", "indigo", "amber", "rose", "slate"];

function MetricCard({
  label,
  value,
  note,
  icon,
  color,
  meter,
  meterColor,
  to,
}: {
  label: string;
  value: string | number;
  note: string;
  icon: React.ReactNode;
  color: TileColor;
  meter?: number;
  meterColor?: string;
  to?: string;
}) {
  const navigate = useNavigate();
  return (
    <div
      onClick={to ? () => navigate(to) : undefined}
      className={cn(
        "group relative overflow-hidden rounded-3xl border border-slate-100 bg-white p-6 shadow-lg shadow-slate-900/[0.04] transition-all duration-300",
        to && "cursor-pointer hover:-translate-y-1 hover:shadow-xl",
      )}
    >
      <div
        className={cn(
          "absolute top-0 right-0 -mt-16 -mr-16 size-32 rounded-full bg-gradient-to-br opacity-60 transition-transform duration-300 group-hover:scale-110",
          color === "blue" && "from-blue-400/20 to-blue-600/20",
          color === "emerald" && "from-emerald-400/20 to-emerald-600/20",
          color === "indigo" && "from-indigo-400/20 to-purple-600/20",
          color === "amber" && "from-amber-300/25 to-orange-500/20",
          color === "rose" && "from-rose-400/20 to-red-600/20",
        )}
      />
      <div className="relative">
        <IconTile color={color} className="mb-4 transition-transform duration-300 group-hover:scale-110">
          {icon}
        </IconTile>
        <p className="mb-1.5 text-[12px] font-bold tracking-wide text-slate-500 uppercase">{label}</p>
        <p className="mb-3 text-[32px] leading-9 font-bold text-slate-900 tabular">{value}</p>
        {meter !== undefined && (
          <div className="mb-2">
            <Meter value={meter} color={meterColor} />
          </div>
        )}
        <p className="text-[12px] text-slate-500">{note}</p>
      </div>
    </div>
  );
}

/** Stacked hourly bars (successful vs failed/denied calls) for the last 24 hours. */
function ActivityChart({ data }: { data: Overview["hourly"] }) {
  const max = Math.max(1, ...data.map((d) => d.ok + d.failed));
  const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });
  const ticks = [max, Math.round(max / 2), 0];
  return (
    <div className="flex gap-3">
      <div className="flex h-44 flex-col justify-between pb-6 text-right text-[11px] text-slate-400 tabular">
        {ticks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex h-38 items-end gap-1 border-b border-slate-200" role="img" aria-label="Tool calls per hour, last 24 hours">
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-slate-100" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-slate-100" />
          {data.map((d) => {
            const total = d.ok + d.failed;
            return (
              <div
                key={d.hour}
                className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${hourLabel(d.hour)} · ${total} call${total === 1 ? "" : "s"}${d.failed ? `, ${d.failed} failed or denied` : ""}`}
              >
                {total > 0 && (
                  <div className="flex flex-col overflow-hidden rounded-t-md" style={{ height: `${Math.max(5, (total / max) * 100)}%` }}>
                    {d.failed > 0 && <div className="bg-gradient-to-b from-rose-400 to-red-500" style={{ flexGrow: d.failed }} />}
                    <div className="bg-gradient-to-b from-blue-500 to-indigo-600 transition-opacity group-hover:opacity-80" style={{ flexGrow: d.ok }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-slate-400">
          <span>{data[0] ? hourLabel(data[0].hour) : ""}</span>
          <span>{data[8] ? hourLabel(data[8].hour) : ""}</span>
          <span>{data[16] ? hourLabel(data[16].hour) : ""}</span>
          <span>Now</span>
        </div>
      </div>
    </div>
  );
}

export function OverviewPage() {
  const { isAdmin, user } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/overview"), refetchInterval: 10_000 });
  const d = q.data;
  const enabledServers = d ? d.servers.total - d.servers.disabled : 0;
  const successRate = d && d.last24h.calls ? ((d.last24h.calls - d.last24h.failures) / d.last24h.calls) * 100 : 0;

  return (
    <div className="space-y-6">
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900 p-6 text-white shadow-2xl sm:p-8">
        <div className="pointer-events-none absolute inset-0 opacity-30">
          <div className="absolute -top-48 -left-48 size-96 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 blur-3xl" />
          <div className="absolute -right-40 -bottom-40 size-80 rounded-full bg-gradient-to-tl from-indigo-400 to-cyan-500 blur-3xl" />
        </div>
        <div className="relative">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-5">
              <div className="hidden size-18 shrink-0 items-center justify-center rounded-3xl border border-white/20 bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 shadow-2xl sm:flex">
                <PlugZap className="size-9" />
              </div>
              <div>
                <h1 className="bg-gradient-to-r from-white to-blue-100 bg-clip-text text-[30px] leading-tight font-bold text-transparent sm:text-[38px]">
                  Welcome back, {user?.name.split(" ")[0]}
                </h1>
                <p className="mt-1 text-[15px] font-medium text-blue-200">Every team MCP server behind one endpoint, with access control and a full audit trail.</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {d && (
                    <span
                      className={cn(
                        "flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold",
                        d.servers.unreachable ? "border-amber-400/30 bg-amber-500/20 text-amber-200" : "border-emerald-400/30 bg-emerald-500/20 text-emerald-200",
                      )}
                    >
                      <span className={cn("size-2 animate-pulse rounded-full", d.servers.unreachable ? "bg-amber-400" : "bg-emerald-400")} />
                      {d.servers.unreachable ? `${d.servers.unreachable} ${d.servers.unreachable === 1 ? "server" : "servers"} unreachable` : "All systems live"}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-[13px] text-blue-200">
                    <Clock3 className="size-4" /> {isAdmin ? "Whole team" : "Your activity"} · last 24 hours
                  </span>
                </div>
              </div>
            </div>
            {meta.data && (
              <div className="rounded-2xl border border-white/20 bg-white/10 p-5 shadow-xl backdrop-blur-xl lg:max-w-sm">
                <div className="text-[12px] font-semibold tracking-wide text-blue-200 uppercase">MCP endpoint</div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-[14px] font-semibold text-white">{meta.data.mcpUrl}</code>
                  <CopyButton value={meta.data.mcpUrl} className="border-white/30 bg-white/15 text-white hover:bg-white/25" />
                </div>
                <Link to="/keys" className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-blue-200 hover:text-white">
                  Get an API key and client config <ArrowRight className="size-3.5" />
                </Link>
              </div>
            )}
          </div>

          <div className="mt-7 flex flex-wrap gap-3">
            {[
              { label: "Servers online", value: d ? `${d.servers.connected}/${enabledServers}` : "—", icon: <ServerCog className="size-5 text-blue-300" /> },
              { label: "Tools available", value: d?.tools ?? "—", icon: <Wrench className="size-5 text-purple-300" /> },
              { label: "Calls today", value: d?.last24h.calls ?? "—", icon: <Activity className="size-5 text-cyan-300" /> },
              { label: "Success rate", value: d && d.last24h.calls ? `${successRate.toFixed(1)}%` : "—", icon: <CheckCircle2 className="size-5 text-emerald-300" /> },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-3 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 backdrop-blur-sm">
                {s.icon}
                <div>
                  <div className="text-[18px] leading-6 font-bold text-white tabular">{s.value}</div>
                  <div className="text-[11px] text-blue-200">{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {d ? (
          <>
            <MetricCard
              label="Connected servers"
              value={`${d.servers.connected}/${enabledServers}`}
              note={d.servers.disabled ? `${d.servers.disabled} disabled by an admin` : "All registered servers enabled"}
              icon={<ServerCog />}
              color="blue"
              meter={enabledServers ? (d.servers.connected / enabledServers) * 100 : 0}
              to="/servers"
            />
            <MetricCard label="Tools" value={d.tools} note={isAdmin ? "Across all enabled servers" : "Available to you"} icon={<Wrench />} color="indigo" to="/tools" />
            <MetricCard
              label="Tool calls · 24h"
              value={d.last24h.calls}
              note={isAdmin ? `${d.last24h.users} ${d.last24h.users === 1 ? "person" : "people"} · ${percent(d.last24h.calls - d.last24h.failures, d.last24h.calls)} succeeded` : `${percent(d.last24h.calls - d.last24h.failures, d.last24h.calls)} succeeded`}
              icon={<Activity />}
              color="emerald"
              meter={successRate}
              meterColor="bg-emerald-500"
              to="/audit"
            />
            <MetricCard
              label="Failed or denied"
              value={d.last24h.failures}
              note={d.last24h.failures ? `${percent(d.last24h.failures, d.last24h.calls)} of calls · see audit log` : "No failures in the last 24 hours"}
              icon={<ShieldAlert />}
              color="rose"
              meter={d.last24h.calls ? (d.last24h.failures / d.last24h.calls) * 100 : 0}
              meterColor="bg-red-500"
              to="/audit"
            />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-52 rounded-3xl" />)
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-lg shadow-slate-900/[0.04] sm:p-7">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-[18px] font-bold text-slate-900">Tool calls per hour</h3>
              <div className="flex items-center gap-4 text-[12px] text-slate-600">
                <span className="flex items-center gap-1.5">
                  <span className="size-3 rounded bg-gradient-to-b from-blue-500 to-indigo-600" /> Succeeded
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-3 rounded bg-gradient-to-b from-rose-400 to-red-500" /> Failed or denied
                </span>
              </div>
            </div>
            {d ? <ActivityChart data={d.hourly} /> : <Skeleton className="h-44 w-full" />}
          </div>

          <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-lg shadow-slate-900/[0.04] sm:p-7">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-[18px] font-bold text-slate-900">Server health</h3>
              <Link to="/servers" className="flex items-center gap-1 text-[13px] font-semibold text-blue-600 hover:text-blue-700">
                Manage servers <ArrowRight className="size-4" />
              </Link>
            </div>
            {!d ? (
              <Skeleton className="h-40 w-full" />
            ) : d.servers.list.length === 0 ? (
              <EmptyState icon={<ServerCog />} title="No servers registered">An admin can add MCP servers from the Servers page.</EmptyState>
            ) : (
              <div className="space-y-3">
                {d.servers.list.map((s, i) => {
                  const usage = d.last24h.perServer.find((p) => p.server === s.slug);
                  return (
                    <div
                      key={s.id}
                      onClick={() => navigate(`/servers/${s.id}`)}
                      className="flex cursor-pointer items-center gap-4 rounded-2xl bg-slate-50 p-4 transition-colors hover:bg-slate-100"
                    >
                      <IconTile color={s.slug.startsWith("store-") || s.description.toLowerCase().includes("store") ? "amber" : serverColors[i % serverColors.length]} size="sm">
                        {s.slug === "woocommerce" || s.description.toLowerCase().includes("store") ? <Store /> : <ServerCog />}
                      </IconTile>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-slate-900">{s.name}</p>
                        {s.status === "unreachable" && s.statusDetail ? (
                          <p className="truncate text-[12px] text-red-600">{s.statusDetail}</p>
                        ) : (
                          <p className="text-[12px] text-slate-500">
                            {s.toolCount} tools · {usage?.calls ?? 0} calls today{usage?.p95_ms ? ` · p95 ${duration(usage.p95_ms)}` : ""}
                          </p>
                        )}
                      </div>
                      <div className="hidden text-right text-[12px] text-slate-400 sm:block">{s.enabled ? `checked ${relativeTime(s.lastCheckedAt)}` : ""}</div>
                      <StatusBadge status={s.status} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-lg shadow-slate-900/[0.04] sm:p-7">
          <div className="mb-5 flex items-center justify-between">
            <h3 className="text-[18px] font-bold text-slate-900">Recent tool calls</h3>
            <Link to="/audit" className="flex items-center gap-1 text-[13px] font-semibold text-blue-600 hover:text-blue-700">
              View all <ArrowRight className="size-4" />
            </Link>
          </div>
          {!d ? (
            <Skeleton className="h-80 w-full" />
          ) : d.recentCalls.length === 0 ? (
            <EmptyState icon={<Activity />} title="No tool calls yet">Calls from the chat agent and MCP clients appear here.</EmptyState>
          ) : (
            <div className="space-y-3">
              {d.recentCalls.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 p-3.5 transition-colors hover:bg-slate-100">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-[12px] font-bold text-white uppercase">
                      {(c.server_slug ?? "?").slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[13px] font-semibold text-slate-900">{c.tool}</p>
                      <p className="truncate text-[12px] text-slate-500" title={dateTime(c.created_at)}>
                        {isAdmin ? `${c.user_email ?? "deleted user"} · ` : ""}
                        {c.source === "chat" ? "Chat" : "MCP client"} · {relativeTime(c.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize", outcomeBadge[c.outcome])}>{c.outcome}</span>
                    <p className="mt-1 text-[11px] text-slate-400 tabular">{duration(c.duration_ms)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
