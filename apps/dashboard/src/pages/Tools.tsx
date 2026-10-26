import { useQuery } from "@tanstack/react-query";
import { Search, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ToolRow } from "@/components/ToolRow";
import { Input, Select } from "@/components/ui/form";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";
import { api, type ToolInfo } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function ToolsPage() {
  const { isAdmin } = useAuth();
  const q = useQuery({ queryKey: ["tools"], queryFn: () => api.get<{ tools: ToolInfo[] }>("/tools") });
  const [search, setSearch] = useState("");
  const [server, setServer] = useState("all");
  const [access, setAccess] = useState("all");

  const tools = q.data?.tools ?? [];
  const servers = useMemo(() => [...new Map(tools.map((t) => [t.server.slug, t.server])).values()], [tools]);
  const filtered = tools.filter((t) => {
    if (server !== "all" && t.server.slug !== server) return false;
    if (access === "read" && t.readOnly !== true) return false;
    if (access === "write" && t.readOnly !== false) return false;
    if (access === "admin" && !t.adminOnly) return false;
    const s = search.trim().toLowerCase();
    return !s || `${t.name} ${t.description} ${t.title ?? ""}`.toLowerCase().includes(s);
  });

  // Group by server, keeping server order stable.
  const groups = servers
    .map((s) => ({ server: s, tools: filtered.filter((t) => t.server.slug === s.slug) }))
    .filter((g) => g.tools.length > 0);

  // Upstream names that more than one server exposes: shown so the namespacing is visible.
  const collisions = useMemo(() => {
    const count = new Map<string, number>();
    for (const t of tools) count.set(t.upstreamName, (count.get(t.upstreamName) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n > 1).map(([name]) => name));
  }, [tools]);

  return (
    <>
      <PageHeader
        title="Tools"
        description={
          <>
            Every tool from enabled servers, exactly as MCP clients and the chat agent see them{isAdmin ? "" : " with your role"}. Names are{" "}
            <code className="text-[12.5px] text-ink">{"<server>__<tool>"}</code>, so two servers can both expose a tool called <code className="text-[12.5px] text-ink">search</code>.
          </>
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tools" className="pl-8" aria-label="Search tools" />
        </div>
        <Select value={server} onChange={(e) => setServer(e.target.value)} className="sm:w-48" aria-label="Filter by server">
          <option value="all">All servers</option>
          {servers.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select value={access} onChange={(e) => setAccess(e.target.value)} className="sm:w-44" aria-label="Filter by access">
          <option value="all">Any access</option>
          <option value="read">Read-only</option>
          <option value="write">Writes data</option>
          {isAdmin && <option value="admin">Admins only</option>}
        </Select>
      </div>

      {q.isLoading ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon={<Wrench />} title={tools.length ? "No tools match these filters" : "No tools available"}>
            {tools.length ? "Try a different search or filter." : "Enable or add an MCP server to make its tools available."}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <Card key={g.server.slug}>
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Link to={`/servers/${g.server.id}`} className="text-[13px] font-semibold text-ink hover:underline">
                    {g.server.name}
                  </Link>
                  {g.server.status === "unreachable" && <Badge tone="bad">unreachable: calls will fail</Badge>}
                </div>
                <span className="text-[12px] text-muted">{g.tools.length} tools</span>
              </div>
              <ul className="divide-y divide-line">
                {g.tools.map((t) => (
                  <ToolRow
                    key={t.name}
                    name={t.name}
                    upstreamName={t.upstreamName}
                    description={t.description}
                    schema={t.inputSchema}
                    readOnly={t.readOnly}
                    adminOnly={t.adminOnly}
                    meta={collisions.has(t.upstreamName) ? <Badge tone="neutral">name shared with another server</Badge> : null}
                  />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
