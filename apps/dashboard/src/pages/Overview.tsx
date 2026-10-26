import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Card, EmptyState, ErrorState, PageHeader, SectionTitle, Skeleton, StatusBadge } from "@/components/ui/misc";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { api, type AuditItem, type Overview } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, dateTime, duration, percent, relativeTime } from "@/lib/format";

export function OutcomeDot({ outcome }: { outcome: AuditItem["outcome"] }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", outcome === "success" ? "bg-ok" : outcome === "denied" ? "bg-warn" : "bg-bad")} />;
}

function Metric({ label, value, note, tone }: { label: string; value: string | number; note?: string; tone?: "bad" }) {
  return (
    <div className="min-w-0 py-1">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cn("mt-1 text-[22px] leading-7 font-medium tracking-[-0.02em] tabular", tone === "bad" ? "text-bad" : "text-ink")}>{value}</div>
      {note && <div className="mt-0.5 truncate text-[12px] text-faint">{note}</div>}
    </div>
  );
}

/** Stacked hourly bars (successful vs failed/denied calls) for the last 24 hours. */
function ActivityChart({ data }: { data: Overview["hourly"] }) {
  const max = Math.max(1, ...data.map((d) => d.ok + d.failed));
  const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <div>
      <div className="flex h-32 items-end gap-[3px]" role="img" aria-label="Tool calls per hour, last 24 hours">
        {data.map((d) => {
          const total = d.ok + d.failed;
          return (
            <div
              key={d.hour}
              className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${hourLabel(d.hour)} · ${total} call${total === 1 ? "" : "s"}${d.failed ? `, ${d.failed} failed` : ""}`}
            >
              {total === 0 ? (
                <div className="h-px bg-line" />
              ) : (
                <div className="flex flex-col overflow-hidden rounded-[2px]" style={{ height: `${Math.max(6, (total / max) * 100)}%` }}>
                  {d.failed > 0 && <div className="bg-bad/80" style={{ flexGrow: d.failed }} />}
                  <div className="bg-ink/85 group-hover:bg-ink" style={{ flexGrow: d.ok }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-2xs text-faint">
        <span>{data[0] ? hourLabel(data[0].hour) : ""}</span>
        <span>{data[12] ? hourLabel(data[12].hour) : ""}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function LogLine({ item, showUser }: { item: AuditItem; showUser: boolean }) {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 px-4 py-2 font-mono text-[12px]">
      <span className="text-faint tabular" title={dateTime(item.created_at)}>
        {new Date(item.created_at).toLocaleTimeString(undefined, { hour12: false })}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <OutcomeDot outcome={item.outcome} />
          <span className="truncate text-ink">{item.tool}</span>
        </span>
        <span className="block truncate pl-3.5 font-sans text-[12px] text-muted">
          {showUser && <>{item.user_email ?? "deleted user"} · </>}
          {item.source === "chat" ? "chat" : "mcp client"}
          {item.error && <span className={item.outcome === "denied" ? "text-warn" : "text-bad"}> · {item.error}</span>}
        </span>
      </span>
      <span className="text-faint tabular">{duration(item.duration_ms)}</span>
    </li>
  );
}

export function OverviewPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/overview"), refetchInterval: 10_000 });
  const d = q.data;

  return (
    <>
      <PageHeader title="Overview" actions={<span className="text-[12px] text-muted">{isAdmin ? "Whole team" : "Your activity"} · last 24 hours</span>} />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {/* Metrics */}
      <div className="mb-8 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-line py-5 md:grid-cols-5">
        {d ? (
          <>
            <Metric label="Servers online" value={`${d.servers.connected}/${d.servers.total}`} note={d.servers.disabled ? `${d.servers.disabled} disabled` : undefined} />
            <Metric label="Unreachable" value={d.servers.unreachable} tone={d.servers.unreachable ? "bad" : undefined} />
            <Metric label="Tools" value={d.tools} />
            <Metric label="Tool calls" value={d.last24h.calls} note={isAdmin ? `${d.last24h.users} ${d.last24h.users === 1 ? "person" : "people"}` : undefined} />
            <Metric label="Failure rate" value={percent(d.last24h.failures, d.last24h.calls)} note={`${d.last24h.failures} failed or denied`} tone={d.last24h.failures ? "bad" : undefined} />
          </>
        ) : (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2 py-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-12" />
            </div>
          ))
        )}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          <section>
            <SectionTitle
              aside={
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-[2px] bg-ink/85" /> Succeeded
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-[2px] bg-bad/80" /> Failed or denied
                  </span>
                </span>
              }
            >
              Tool calls per hour
            </SectionTitle>
            <Card className="p-4">{d ? <ActivityChart data={d.hourly} /> : <Skeleton className="h-36 w-full" />}</Card>
          </section>

          <section>
            <SectionTitle
              aside={
                <Link to="/servers" className="inline-flex items-center gap-0.5 text-ink-2 hover:text-ink">
                  Manage <ArrowUpRight className="size-3.5" />
                </Link>
              }
            >
              Servers
            </SectionTitle>
            <Card>
              {!d ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              ) : d.servers.list.length === 0 ? (
                <EmptyState title="No servers registered">Admins add MCP servers on the Servers page.</EmptyState>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Name</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Calls</Th>
                      <Th className="hidden text-right sm:table-cell">p95</Th>
                      <Th className="hidden text-right md:table-cell">Checked</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.servers.list.map((s) => {
                      const usage = d.last24h.perServer.find((p) => p.server === s.slug);
                      return (
                        <Tr key={s.id} onClick={() => navigate(`/servers/${s.id}`)}>
                          <Td>
                            <div className="font-medium">{s.name}</div>
                            {s.status === "unreachable" && s.statusDetail ? (
                              <div className="max-w-[260px] truncate text-[12px] text-bad">{s.statusDetail}</div>
                            ) : (
                              <div className="text-[12px] text-muted">{s.toolCount} tools</div>
                            )}
                          </Td>
                          <Td>
                            <StatusBadge status={s.status} />
                          </Td>
                          <Td className="text-right tabular">
                            {usage?.calls ?? 0}
                            {usage?.failures ? <span className="ml-1 text-bad">({usage.failures})</span> : null}
                          </Td>
                          <Td className="hidden text-right text-muted tabular sm:table-cell">{usage ? duration(usage.p95_ms) : "—"}</Td>
                          <Td className="hidden text-right text-muted md:table-cell">{s.enabled ? relativeTime(s.lastCheckedAt) : "—"}</Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Card>
          </section>
        </div>

        <section className="min-w-0">
          <SectionTitle
            aside={
              <Link to="/audit" className="inline-flex items-center gap-0.5 text-ink-2 hover:text-ink">
                Audit log <ArrowUpRight className="size-3.5" />
              </Link>
            }
          >
            Recent activity
          </SectionTitle>
          <Card>
            {!d ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            ) : d.recentCalls.length === 0 ? (
              <EmptyState title="No tool calls yet">Calls from the chat agent and MCP clients appear here.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {d.recentCalls.map((i) => (
                  <LogLine key={i.id} item={i} showUser={isAdmin} />
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </>
  );
}
