import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ScrollText, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { api, type AuditItem, type Server, type TeamMember } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, dateTime, duration } from "@/lib/format";
import { OutcomeDot } from "./Overview";

const PAGE_SIZE = 25;

const outcomeLabel: Record<AuditItem["outcome"], string> = { success: "Success", error: "Error", denied: "Denied" };

export function AuditPage() {
  const { isAdmin } = useAuth();
  const [filters, setFilters] = useState({ search: "", userId: "", serverSlug: "", outcome: "", source: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const set = (k: keyof typeof filters) => (v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      // Date inputs are local calendar days; send the full local day as ISO instants.
      if (k === "from") p.set(k, new Date(`${v}T00:00:00`).toISOString());
      else if (k === "to") p.set(k, new Date(`${v}T23:59:59.999`).toISOString());
      else p.set(k, v.trim());
    }
    return p.toString();
  }, [filters, page]);

  const q = useQuery({
    queryKey: ["audit", query],
    queryFn: () => api.get<{ items: AuditItem[]; total: number }>(`/audit?${query}`),
    placeholderData: keepPreviousData,
    refetchInterval: page === 1 ? 10_000 : false,
  });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: TeamMember[] }>("/users"), enabled: isAdmin });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.get<{ servers: Server[] }>("/servers") });

  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const active = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title="Audit log"
        description={isAdmin ? "Every tool call through the gateway, by anyone, from any client." : "Every tool call you made, from any client."}
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto_auto]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={filters.search} onChange={(e) => set("search")(e.target.value)} placeholder="Tool or error text" className="pl-8" aria-label="Search" />
        </div>
        {isAdmin ? (
          <Select value={filters.userId} onChange={(e) => set("userId")(e.target.value)} aria-label="User">
            <option value="">All people</option>
            {users.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select value={filters.serverSlug} onChange={(e) => set("serverSlug")(e.target.value)} aria-label="Server">
          <option value="">All servers</option>
          {servers.data?.servers.map((s) => (
            <option key={s.id} value={s.slug}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select value={filters.outcome} onChange={(e) => set("outcome")(e.target.value)} aria-label="Outcome">
          <option value="">Any outcome</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="denied">Denied</option>
        </Select>
        <Select value={filters.source} onChange={(e) => set("source")(e.target.value)} aria-label="Source">
          <option value="">Any source</option>
          <option value="mcp">MCP client</option>
          <option value="chat">Chat agent</option>
        </Select>
        <Input type="date" value={filters.from} onChange={(e) => set("from")(e.target.value)} aria-label="From date" title="From" />
        <Input type="date" value={filters.to} onChange={(e) => set("to")(e.target.value)} aria-label="To date" title="To" />
      </div>

      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <Card>
        {q.isLoading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : !q.data?.items.length ? (
          <EmptyState icon={<ScrollText />} title={active ? "No calls match these filters" : "No tool calls yet"}>
            {active ? "Adjust or clear the filters." : "Calls appear here as soon as anyone uses a tool through the gateway."}
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Time</Th>
                {isAdmin && <Th>Person</Th>}
                <Th>Tool</Th>
                <Th className="hidden md:table-cell">Source</Th>
                <Th className="text-right">Duration</Th>
                <Th>Outcome</Th>
              </tr>
            </THead>
            <tbody className={cn(q.isFetching && q.isPlaceholderData && "opacity-60")}>
              {q.data.items.map((i) => (
                <Fragment key={i.id}>
                  <Tr onClick={i.error ? () => setExpanded(expanded === i.id ? null : i.id) : undefined}>
                    <Td className="whitespace-nowrap text-muted tabular">{dateTime(i.created_at)}</Td>
                    {isAdmin && <Td className="max-w-[200px] truncate">{i.user_email ?? <span className="text-faint">deleted user</span>}</Td>}
                    <Td className="max-w-[320px]">
                      <code className="block truncate text-[12.5px]">{i.tool}</code>
                      <div className="text-[11.5px] text-faint">{i.server_slug ? `server ${i.server_slug}` : "no server resolved"}</div>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <Badge>{i.source === "chat" ? "Chat agent" : "MCP client"}</Badge>
                    </Td>
                    <Td className="text-right text-muted tabular">{duration(i.duration_ms)}</Td>
                    <Td>
                      <span className={cn("inline-flex items-center gap-1.5 text-[13px]", i.outcome === "success" ? "text-ok" : i.outcome === "denied" ? "text-warn" : "text-bad")}>
                        <OutcomeDot outcome={i.outcome} /> {outcomeLabel[i.outcome]}
                      </span>
                      {i.error && expanded !== i.id && <div className="max-w-[220px] truncate text-[11.5px] text-muted">{i.error}</div>}
                    </Td>
                  </Tr>
                  {expanded === i.id && i.error && (
                    <tr className="border-b border-line bg-subtle/60">
                      <td colSpan={isAdmin ? 6 : 5} className="px-4 py-2.5 text-[12.5px] text-ink-2">
                        <span className="font-medium text-ink">Detail:</span> {i.error}
                        {i.upstream_tool && (
                          <span className="ml-2 text-faint">
                            (upstream tool <code>{i.upstream_tool}</code>)
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
        {total > 0 && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12.5px] text-muted">
            <span className="tabular">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft /> Previous
              </Button>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
