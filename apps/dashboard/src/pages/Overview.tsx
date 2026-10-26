import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Activity, CircleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CodeLine, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from "@/components/ui/misc";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { api, type AuditItem, type Overview } from "@/lib/api";
import { useAuth, useMeta } from "@/lib/auth";
import { cn, dateTime, duration, percent, relativeTime } from "@/lib/format";

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "bad" | "muted" }) {
  return (
    <div className="px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tracking-[-0.01em] tabular", tone === "bad" ? "text-bad" : "text-ink")}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

export function OutcomeDot({ outcome }: { outcome: AuditItem["outcome"] }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", outcome === "success" ? "bg-ok" : outcome === "denied" ? "bg-warn" : "bg-bad")} />;
}

function ActivityRow({ item, showError }: { item: AuditItem; showError?: boolean }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span className="mt-1.5">
        <OutcomeDot outcome={item.outcome} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <code className="truncate text-[12.5px] text-ink">{item.tool}</code>
          <span className="shrink-0 text-[12px] text-faint" title={dateTime(item.created_at)}>
            {relativeTime(item.created_at)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted">
          {item.user_email ?? "deleted user"} · {item.source === "chat" ? "chat agent" : "MCP client"} · {duration(item.duration_ms)}
        </div>
        {showError && item.error && <div className="mt-1 line-clamp-2 text-[12px] text-bad">{item.error}</div>}
      </div>
    </li>
  );
}

export function OverviewPage() {
  const { isAdmin } = useAuth();
  const meta = useMeta();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/overview"), refetchInterval: 10_000 });
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Overview"
        description={isAdmin ? "Health of the team's MCP servers and tool activity over the last 24 hours." : "Server health and your own tool activity over the last 24 hours."}
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <Card className="mb-6 grid grid-cols-2 divide-line max-md:[&>*:nth-child(n+3)]:border-t md:grid-cols-5 md:divide-x">
        {d ? (
          <>
            <Stat label="Servers connected" value={`${d.servers.connected} / ${d.servers.total}`} sub={d.servers.disabled ? `${d.servers.disabled} disabled` : "All enabled"} />
            <Stat label="Unreachable" value={d.servers.unreachable} tone={d.servers.unreachable ? "bad" : undefined} sub={d.servers.unreachable ? "Needs attention" : "None"} />
            <Stat label="Tools available" value={d.tools} sub={isAdmin ? "Across enabled servers" : "Visible to you"} />
            <Stat label="Tool calls" value={d.last24h.calls} sub={isAdmin ? `${d.last24h.users} ${d.last24h.users === 1 ? "person" : "people"}` : "By you"} />
            <Stat label="Failure rate" value={percent(d.last24h.failures, d.last24h.calls)} sub={`${d.last24h.failures} failed or denied`} tone={d.last24h.failures ? "bad" : undefined} />
          </>
        ) : (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2 px-4 py-3.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-12" />
            </div>
          ))
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Servers"
              description="Checked every few seconds by the gateway."
              actions={
                <Link to="/servers" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                  Manage <ArrowRight className="size-3.5" />
                </Link>
              }
            />
            {!d ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : d.servers.list.length === 0 ? (
              <EmptyState title="No servers registered">An administrator can add MCP servers from the MCP servers page.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {d.servers.list.map((s) => (
                  <li key={s.id}>
                    <Link to={`/servers/${s.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-subtle/70">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-ink">{s.name}</span>
                          <code className="text-[11.5px] text-faint">{s.slug}</code>
                        </div>
                        {s.status === "unreachable" && s.statusDetail ? (
                          <div className="mt-0.5 truncate text-[12px] text-bad">{s.statusDetail}</div>
                        ) : (
                          <div className="mt-0.5 text-[12px] text-muted">
                            {s.toolCount} tools · checked {relativeTime(s.lastCheckedAt)}
                          </div>
                        )}
                      </div>
                      <span className="hidden text-[12px] text-faint tabular sm:block">{s.status === "connected" ? duration(s.latencyMs) : ""}</span>
                      <StatusBadge status={s.status} className="w-26 shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Usage by server" description={isAdmin ? "Last 24 hours, all team members." : "Last 24 hours, your calls."} />
            {d && d.last24h.perServer.length === 0 ? (
              <EmptyState icon={<Activity />} title="No tool calls yet">
                Calls made from the chat agent or an MCP client will show up here.
              </EmptyState>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Server</Th>
                    <Th className="text-right">Calls</Th>
                    <Th className="text-right">Failed</Th>
                    <Th className="text-right">Avg</Th>
                    <Th className="text-right">p95</Th>
                  </tr>
                </THead>
                <tbody>
                  {d?.last24h.perServer.map((p) => (
                    <Tr key={p.server}>
                      <Td>
                        <code className="text-[12.5px]">{p.server}</code>
                      </Td>
                      <Td className="text-right tabular">{p.calls}</Td>
                      <Td className={cn("text-right tabular", p.failures ? "text-bad" : "text-muted")}>
                        {p.failures} <span className="text-faint">({percent(p.failures, p.calls)})</span>
                      </Td>
                      <Td className="text-right text-muted tabular">{duration(p.avg_ms)}</Td>
                      <Td className="text-right text-muted tabular">{duration(p.p95_ms)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Connect an MCP client" description="One URL for every enabled server. Authenticate with your own API key." />
            <div className="space-y-3 p-4">
              {meta.data ? <CodeLine value={meta.data.mcpUrl} /> : <Skeleton className="h-9 w-full" />}
              <Link to="/keys" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                Create an API key and copy client config <ArrowRight className="size-3.5" />
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent failures" />
            {d && d.recentFailures.length === 0 ? (
              <p className="px-4 py-5 text-[13px] text-muted">No failed or denied calls.</p>
            ) : (
              <ul className="divide-y divide-line">{d?.recentFailures.map((i) => <ActivityRow key={i.id} item={i} showError />)}</ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Latest calls"
              actions={
                <Link to="/audit" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                  Audit log <ArrowRight className="size-3.5" />
                </Link>
              }
            />
            {d && d.recentCalls.length === 0 ? (
              <EmptyState icon={<CircleAlert />} title="Nothing yet">
                Try the chat agent or connect a client.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">{d?.recentCalls.map((i) => <ActivityRow key={i.id} item={i} />)}</ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
