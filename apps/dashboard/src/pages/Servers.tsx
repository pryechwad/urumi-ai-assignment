import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Plus, Power, RefreshCw, Server as ServerIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ServerFormDialog } from "@/components/ServerForm";
import { useServerActions } from "@/components/server-actions";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, Switch } from "@/components/ui/misc";
import { ConfirmDialog, DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from "@/components/ui/overlay";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { api, type Server } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, duration, relativeTime } from "@/lib/format";

export function ServersPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["servers"], queryFn: () => api.get<{ servers: Server[] }>("/servers"), refetchInterval: 10_000 });
  const { toggle, refresh, remove } = useServerActions();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Server | undefined>();
  const [removing, setRemoving] = useState<Server | null>(null);

  const servers = q.data?.servers ?? [];

  return (
    <>
      <PageHeader
        title="Servers"
        description={<>Upstream MCP servers. Their tools are exposed as <code className="text-ink-2">slug__tool</code>.</>}
        actions={
          isAdmin && (
            <Button
              variant="primary"
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              <Plus /> Add server
            </Button>
          )
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <Card>
        {q.isLoading ? (
          <div className="space-y-4 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<ServerIcon />}
            title="No MCP servers yet"
            action={
              isAdmin && (
                <Button variant="primary" onClick={() => setFormOpen(true)}>
                  <Plus /> Add server
                </Button>
              )
            }
          >
            Register a server by URL. Members then get its tools through the gateway without configuring anything.
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Server</Th>
                <Th>Status</Th>
                <Th className="text-right">Tools</Th>
                <Th className="hidden md:table-cell">Auth</Th>
                <Th className="hidden lg:table-cell">Last check</Th>
                {isAdmin && <Th className="w-28 text-right">Enabled</Th>}
                {isAdmin && <Th className="w-10" />}
              </tr>
            </THead>
            <tbody>
              {servers.map((s) => (
                <Tr key={s.id} onClick={() => navigate(`/servers/${s.id}`)}>
                  <Td className="max-w-[360px]">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <code className="text-[11.5px] text-faint">{s.slug}</code>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{s.url}</div>
                  </Td>
                  <Td>
                    <StatusBadge status={s.status} />
                    {s.status === "unreachable" && s.statusDetail && (
                      <div className="mt-0.5 max-w-[240px] truncate text-[12px] text-bad" title={s.statusDetail}>
                        {s.statusDetail}
                      </div>
                    )}
                    {s.status === "connected" && <div className="mt-0.5 text-[12px] text-faint tabular">{duration(s.latencyMs)}</div>}
                  </Td>
                  <Td className="text-right tabular">{s.toolCount}</Td>
                  <Td className="hidden md:table-cell">
                    {s.auth.type === "none" ? (
                      <span className="text-muted">None</span>
                    ) : (
                      <Badge>{s.auth.type === "bearer" ? "Bearer token" : s.auth.headerName}</Badge>
                    )}
                  </Td>
                  <Td className="hidden text-muted lg:table-cell" title={dateTime(s.lastCheckedAt)}>
                    {s.enabled ? relativeTime(s.lastCheckedAt) : "—"}
                  </Td>
                  {isAdmin && (
                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Switch label={`Enable ${s.name}`} checked={s.enabled} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(s)} />
                    </Td>
                  )}
                  {isAdmin && (
                    <Td className="pr-2" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${s.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownTrigger>
                        <DropdownContent>
                          <DropdownItem
                            onSelect={() => {
                              setEditing(s);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil /> Edit
                          </DropdownItem>
                          <DropdownItem onSelect={() => refresh.mutate(s)} disabled={!s.enabled}>
                            <RefreshCw /> Check connection
                          </DropdownItem>
                          <DropdownItem onSelect={() => toggle.mutate(s)}>
                            <Power /> {s.enabled ? "Disable" : "Enable"}
                          </DropdownItem>
                          <DropdownSeparator />
                          <DropdownItem destructive onSelect={() => setRemoving(s)}>
                            <Trash2 /> Remove
                          </DropdownItem>
                        </DropdownContent>
                      </DropdownMenu>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ServerFormDialog open={formOpen} onOpenChange={setFormOpen} server={editing} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        description="Its tools disappear for everyone immediately and its stored credential is deleted. Past audit entries are kept."
        confirmLabel="Remove server"
        onConfirm={() => remove.mutateAsync(removing!)}
      />
    </>
  );
}
