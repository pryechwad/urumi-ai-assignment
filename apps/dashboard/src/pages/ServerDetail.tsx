import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Power, RefreshCw, Trash2, Wrench } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ServerFormDialog } from "@/components/ServerForm";
import { useServerActions } from "@/components/server-actions";
import { ToolRow } from "@/components/ToolRow";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, ErrorState, Field, Skeleton, StatusBadge, Switch } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlay";
import { api, type ServerDetail } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, duration, relativeTime } from "@/lib/format";

export function ServerDetailPage() {
  const { id = "" } = useParams();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["server", id], queryFn: () => api.get<ServerDetail>(`/servers/${id}`), refetchInterval: 10_000 });
  const { toggle, refresh, remove } = useServerActions();
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const policy = useMutation({
    mutationFn: (v: { tool: string; adminOnly: boolean }) => api.put("/tools/policy", { serverId: id, ...v }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ["server", id] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
      toast.success(v.adminOnly ? `${v.tool} is now admin-only` : `${v.tool} is available to members`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data?.server;

  return (
    <>
      <Link to="/servers" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> MCP servers
      </Link>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {s ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-semibold tracking-[-0.01em]">{s.name}</h1>
                <StatusBadge status={s.status} />
              </div>
              <p className="mt-1 max-w-2xl text-sm text-muted">{s.description || "No description."}</p>
            </>
          ) : (
            <Skeleton className="h-7 w-56" />
          )}
        </div>
        {isAdmin && s && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => refresh.mutate(s)} loading={refresh.isPending} disabled={!s.enabled}>
              <RefreshCw /> Check connection
            </Button>
            <Button onClick={() => setEditOpen(true)}>
              <Pencil /> Edit
            </Button>
            <Button onClick={() => toggle.mutate(s)} loading={toggle.isPending}>
              <Power /> {s.enabled ? "Disable" : "Enable"}
            </Button>
            <Button variant="danger-ghost" onClick={() => setRemoveOpen(true)}>
              <Trash2 /> Remove
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="order-2 lg:order-1">
          <CardHeader
            title={`Tools${s ? ` (${s.toolCount})` : ""}`}
            description={isAdmin ? "Mark write tools as admin-only to hide them from members and reject their calls." : "Names as exposed by the gateway."}
          />
          {!q.data ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : q.data.tools.length === 0 ? (
            <EmptyState icon={<Wrench />} title="No tools discovered">
              {s?.status === "unreachable" ? "The gateway has not been able to connect to this server yet." : "This server did not list any tools."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {q.data.tools.map((t) => (
                <ToolRow
                  key={t.name}
                  name={t.name}
                  upstreamName={t.upstreamName}
                  description={t.description}
                  schema={t.inputSchema}
                  readOnly={t.readOnly}
                  adminOnly={t.adminOnly}
                  control={
                    isAdmin && (
                      <label className="flex items-center gap-2 text-[12px] text-muted">
                        Admins only
                        <Switch
                          label={`Restrict ${t.name} to admins`}
                          checked={t.adminOnly}
                          disabled={policy.isPending}
                          onCheckedChange={(v) => policy.mutate({ tool: t.upstreamName, adminOnly: v })}
                        />
                      </label>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Card>

        <Card className="order-1 h-fit lg:order-2">
          <CardHeader title="Connection" />
          {s ? (
            <dl className="divide-y divide-line px-4 py-1">
              <Field label="Endpoint">
                <code className="text-[12px] break-all">{s.url}</code>
              </Field>
              <Field label="Tool prefix">
                <code className="text-[12px]">{s.slug}__</code>
              </Field>
              <Field label="Credential">
                {s.auth.type === "none" ? "None" : `${s.auth.type === "bearer" ? "Bearer token" : `Header ${s.auth.headerName}`} · stored encrypted`}
              </Field>
              <Field label="Last check">
                <span title={dateTime(s.lastCheckedAt)}>{s.enabled ? relativeTime(s.lastCheckedAt) : "Not checked while disabled"}</span>
              </Field>
              <Field label="Last connected">
                <span title={dateTime(s.lastConnectedAt)}>{relativeTime(s.lastConnectedAt)}</span>
              </Field>
              <Field label="Discovery latency">{duration(s.latencyMs)}</Field>
              {s.status === "unreachable" && s.statusDetail && (
                <Field label="Last error">
                  <span className="text-bad">{s.statusDetail}</span>
                </Field>
              )}
            </dl>
          ) : (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </Card>
      </div>

      {s && <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} server={s} />}
      {s && (
        <ConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={`Remove ${s.name}?`}
          description="Its tools disappear for everyone immediately and its stored credential is deleted. Past audit entries are kept."
          confirmLabel="Remove server"
          onConfirm={async () => {
            await remove.mutateAsync(s);
            navigate("/servers");
          }}
        />
      )}
    </>
  );
}
