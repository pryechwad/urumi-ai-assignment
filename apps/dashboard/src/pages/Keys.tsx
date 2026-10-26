import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ClientConfig } from "@/components/ClientConfig";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardHeader, CodeLine, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { api, type ApiKey, type TeamMember } from "@/lib/api";
import { useAuth, useMeta } from "@/lib/auth";
import { cn, dateTime, relativeTime } from "@/lib/format";

function CreateKeyDialog({ open, onOpenChange, presetUserId }: { open: boolean; onOpenChange: (o: boolean) => void; presetUserId?: string }) {
  const { user, isAdmin } = useAuth();
  const meta = useMeta();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [userId, setUserId] = useState("");
  const [created, setCreated] = useState<{ key: string; owner: string } | null>(null);
  const members = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: TeamMember[] }>("/users"),
    enabled: isAdmin && open,
  });

  useEffect(() => {
    if (open) {
      setName("");
      setUserId(presetUserId ?? user?.id ?? "");
      setCreated(null);
    }
  }, [open, presetUserId, user?.id]);

  const create = useMutation({
    mutationFn: () => api.post<{ key: string }>("/keys", { name: name.trim(), ...(userId && userId !== user?.id ? { userId } : {}) }),
    onSuccess: (res) => {
      const owner = members.data?.users.find((m) => m.id === userId)?.email ?? user?.email ?? "";
      setCreated({ key: res.key, owner });
      void qc.invalidateQueries({ queryKey: ["keys"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const forSomeoneElse = created && created.owner !== user?.email;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={created ? "API key created" : "Create API key"}
      description={created ? undefined : "Keys authenticate MCP clients to the gateway as a specific person. Name it after where it will be used."}
      footer={
        created ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
              Create key
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-4">
          <div className="flex gap-2.5 rounded-lg border border-warn/20 bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Copy this key now. Only a hash is stored, so it cannot be shown again.
              {forSomeoneElse && <> Share it with {created.owner} over a private channel.</>}
            </span>
          </div>
          <CodeLine value={created.key} />
          {meta.data && (
            <div>
              <div className="mb-2 text-[13px] font-medium text-ink">Connect a client</div>
              <ClientConfig url={meta.data.mcpUrl} apiKey={created.key} />
            </div>
          )}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <FormField label="Name" htmlFor="key-name" hint="e.g. “Claude Code on laptop”">
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          </FormField>
          {isAdmin && (
            <FormField label="Issued to" htmlFor="key-user" hint="Calls made with the key are attributed to this person.">
              <Select id="key-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
                {(members.data?.users ?? (user ? [{ id: user.id, email: user.email, name: user.name, status: "active" }] : []))
                  .filter((m) => m.status !== "disabled")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.email}){m.id === user?.id ? " · you" : ""}
                    </option>
                  ))}
              </Select>
            </FormField>
          )}
          {create.isError && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{(create.error as Error).message}</p>}
        </form>
      )}
    </Dialog>
  );
}

export function KeysPage() {
  const { isAdmin } = useAuth();
  const meta = useMeta();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const presetUserId = params.get("issueTo") ?? undefined;

  useEffect(() => {
    if (presetUserId && isAdmin) setCreateOpen(true);
  }, [presetUserId, isAdmin]);

  const q = useQuery({ queryKey: ["keys", scope], queryFn: () => api.get<{ keys: ApiKey[] }>(`/keys?scope=${scope}`) });
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api.post(`/keys/${k.id}/revoke`),
    onSuccess: (_d, k) => {
      void qc.invalidateQueries({ queryKey: ["keys"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(`Key “${k.name}” revoked`, { description: "Requests using it are rejected from now on." });
    },
  });

  const keys = q.data?.keys ?? [];

  return (
    <>
      <PageHeader
        title="API keys"
        description="Each key belongs to one person. MCP clients send it to the gateway; it is never forwarded to upstream servers."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus /> Create key
          </Button>
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="min-w-0">
          <CardHeader
            title={scope === "all" ? "All team keys" : "Your keys"}
            actions={
              isAdmin && (
                <div className="flex rounded-md border border-line p-0.5 text-[12px]">
                  {(["mine", "all"] as const).map((s) => (
                    <button key={s} onClick={() => setScope(s)} className={cn("rounded px-2 py-0.5", scope === s ? "bg-subtle font-medium text-ink" : "text-muted hover:text-ink")}>
                      {s === "mine" ? "Mine" : "Everyone"}
                    </button>
                  ))}
                </div>
              )
            }
          />
          {q.isLoading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound />}
              title="No API keys yet"
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus /> Create key
                </Button>
              }
            >
              Create a key to connect Claude Code, Cursor or MCP Inspector to the gateway.
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Name</Th>
                  {scope === "all" && <Th>Owner</Th>}
                  <Th className="hidden sm:table-cell">Created</Th>
                  <Th>Last used</Th>
                  <Th>Status</Th>
                  <Th className="w-20" />
                </tr>
              </THead>
              <tbody>
                {keys.map((k) => (
                  <Tr key={k.id} className={cn(k.revoked_at && "text-muted")}>
                    <Td>
                      <div className={cn("font-medium", k.revoked_at && "text-muted")}>{k.name}</div>
                      <code className="text-[11.5px] text-faint">{k.prefix}…</code>
                    </Td>
                    {scope === "all" && (
                      <Td>
                        <div className="truncate">{k.user_name}</div>
                        <div className="truncate text-[12px] text-muted">{k.user_email}</div>
                      </Td>
                    )}
                    <Td className="hidden text-muted sm:table-cell" title={dateTime(k.created_at)}>
                      {relativeTime(k.created_at)}
                      {k.created_by_email && k.created_by_email !== k.user_email && <div className="text-[11.5px] text-faint">by {k.created_by_email}</div>}
                    </Td>
                    <Td className="text-muted" title={dateTime(k.last_used_at)}>
                      {relativeTime(k.last_used_at)}
                    </Td>
                    <Td>{k.revoked_at ? <Badge>Revoked {relativeTime(k.revoked_at)}</Badge> : <Badge tone="ok">Active</Badge>}</Td>
                    <Td className="pr-2 text-right">
                      {!k.revoked_at && (
                        <Button variant="danger-ghost" size="sm" onClick={() => setRevoking(k)}>
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card className="h-fit min-w-0">
          <CardHeader title="Gateway endpoint" description="Every enabled server's tools, behind one URL." />
          <div className="space-y-4 p-4">
            {meta.data ? <CodeLine value={meta.data.mcpUrl} /> : <Skeleton className="h-9" />}
            {meta.data && <ClientConfig url={meta.data.mcpUrl} />}
          </div>
        </Card>
      </div>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o && presetUserId) setParams({}, { replace: true });
        }}
        presetUserId={presetUserId}
      />
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description="Any client using this key is rejected on its next request. This cannot be undone."
        confirmLabel="Revoke key"
        onConfirm={() => revoke.mutateAsync(revoking!)}
      />
    </>
  );
}
