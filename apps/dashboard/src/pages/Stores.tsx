import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, Plus, RotateCcw, Store as StoreIcon, Trash2, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/form";
import { EmptyState, ErrorState, IconTile, Meter, PageHeader, Skeleton, Spinner } from "@/components/ui/misc";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { api, type StoreInfo, type StoresResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, dateTime, relativeTime } from "@/lib/format";

const statusStyle: Record<StoreInfo["status"], { label: string; cls: string; dot: string }> = {
  provisioning: { label: "Provisioning", cls: "bg-amber-50 text-amber-700", dot: "bg-amber-500 animate-pulse" },
  ready: { label: "Ready", cls: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  failed: { label: "Failed", cls: "bg-red-50 text-red-700", dot: "bg-red-500" },
  deleting: { label: "Deleting", cls: "bg-slate-100 text-slate-600", dot: "bg-slate-400 animate-pulse" },
};

// Mirrors the server's slug rules so the dialog can preview the URL and tool names.
function slugFrom(name: string) {
  let slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  if (slug && !/^[a-z]/.test(slug)) slug = `s-${slug}`;
  return slug && slug.length < 3 ? `${slug}-shop` : slug;
}

const PHASES = ["Queued", "Creating namespace and resources", "Starting database", "Starting WordPress", "Installing WooCommerce and products", "Starting the store's MCP server", "Registering with the gateway"];

function StoreCard({ store, canManage, onDelete, onRetry, retrying }: { store: StoreInfo; canManage: boolean; onDelete: () => void; onRetry: () => void; retrying: boolean }) {
  const st = statusStyle[store.status];
  const step = Math.max(0, PHASES.indexOf(store.phase));
  return (
    <div className="group relative overflow-hidden rounded-3xl border border-slate-100 bg-white p-6 shadow-lg shadow-slate-900/[0.04] transition-all duration-300 hover:shadow-xl">
      <div className="absolute top-0 right-0 -mt-16 -mr-16 size-36 rounded-full bg-gradient-to-br from-amber-300/25 to-orange-500/20 transition-transform duration-300 group-hover:scale-110" />
      <div className="relative">
        <div className="mb-4 flex items-start justify-between gap-3">
          <IconTile color={store.status === "failed" ? "rose" : store.status === "ready" ? "amber" : "slate"}>
            <StoreIcon />
          </IconTile>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold", st.cls)}>
            <span className={cn("size-2 rounded-full", st.dot)} />
            {st.label}
          </span>
        </div>
        <h3 className="text-[20px] font-bold text-slate-900">{store.name}</h3>
        <a href={store.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium text-blue-600 hover:text-blue-700">
          {store.url.replace(/^https?:\/\//, "")} <ExternalLink className="size-3.5" />
        </a>

        {store.status === "provisioning" && (
          <div className="mt-4 rounded-2xl bg-amber-50/70 p-3.5">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-amber-800">
              <Spinner className="size-3.5" /> {store.phase}
            </div>
            <Meter value={((step + 1) / PHASES.length) * 100} color="bg-gradient-to-r from-amber-400 to-orange-500" />
            {store.reason && <p className="mt-2 text-[12px] text-amber-700">Retrying: {store.reason}</p>}
          </div>
        )}
        {store.status === "failed" && store.reason && (
          <div className="mt-4 flex gap-2 rounded-2xl bg-red-50 p-3.5 text-[13px] text-red-700">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{store.reason}</span>
          </div>
        )}
        {store.status === "deleting" && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-slate-50 p-3.5 text-[13px] text-slate-600">
            <Spinner className="size-3.5" /> Removing namespace, volumes, Secrets and MCP registration…
          </div>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
          <div>
            <dt className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">MCP tools</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-mono font-semibold text-slate-800">
              <Wrench className="size-3.5 text-slate-400" />
              {store.toolPrefix}*{store.status === "ready" ? <span className="font-sans font-normal text-slate-500">({store.toolCount})</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Namespace</dt>
            <dd className="mt-0.5 truncate font-mono text-slate-700">{store.namespace}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Owner</dt>
            <dd className="mt-0.5 truncate text-slate-700">{store.ownerEmail ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Created</dt>
            <dd className="mt-0.5 text-slate-700" title={dateTime(store.createdAt)}>
              {relativeTime(store.createdAt)}
            </dd>
          </div>
        </dl>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          {store.status === "ready" && (
            <a href={store.url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="primary">
                <ExternalLink /> Open store
              </Button>
            </a>
          )}
          {store.status === "failed" && canManage && (
            <Button size="sm" variant="primary" onClick={onRetry} loading={retrying}>
              <RotateCcw /> Retry
            </Button>
          )}
          {store.status !== "deleting" && canManage && (
            <Button size="sm" variant="danger-ghost" onClick={onDelete}>
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function StoresPage() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<StoreInfo | null>(null);

  const q = useQuery({
    queryKey: ["stores"],
    queryFn: () => api.get<StoresResponse>("/stores"),
    refetchInterval: (query) => (query.state.data?.stores.some((s) => s.status === "provisioning" || s.status === "deleting") ? 3000 : 15000),
  });
  useEffect(() => {
    if (createOpen) setName("");
  }, [createOpen]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["stores"] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: ["tools"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const create = useMutation({
    mutationFn: () => api.post<{ store: StoreInfo; created: boolean }>("/stores", { name: name.trim() }),
    onSuccess: (res) => {
      invalidate();
      setCreateOpen(false);
      toast.success(res.created ? `Provisioning ${res.store.name}` : `${res.store.name} already exists`, {
        description: res.created ? "This takes a few minutes. Its tools appear in the gateway automatically when it is ready." : "Showing the existing store.",
      });
    },
  });
  const retry = useMutation({
    mutationFn: (s: StoreInfo) => api.post(`/stores/${s.id}/retry`),
    onSuccess: () => {
      invalidate();
      toast.success("Provisioning restarted");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (s: StoreInfo) => api.del(`/stores/${s.id}`),
    onSuccess: (_d, s) => {
      invalidate();
      toast.success(`Deleting ${s.name}`, { description: "Its MCP tools were removed from the gateway." });
    },
  });

  const data = q.data;
  const slug = slugFrom(name);
  const host = data?.stores[0]?.url ? new URL(data.stores[0].url) : null;
  const atLimit = data ? data.used >= data.maxPerUser : false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stores"
        description="Spin up a new WooCommerce store in its own Kubernetes namespace. Each store gets its own database, storefront and MCP server, connected to the gateway automatically."
        actions={
          data?.enabled && (
            <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={atLimit} title={atLimit ? "You have reached your store limit" : undefined}>
              <Plus /> Create store
            </Button>
          )
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {data && (
        <div className="flex flex-wrap items-center gap-6 rounded-2xl border border-slate-100 bg-white px-5 py-4 shadow-card">
          <div className="min-w-48 flex-1">
            <div className="mb-1.5 flex justify-between text-[13px]">
              <span className="font-semibold text-slate-700">Your stores</span>
              <span className="text-slate-500 tabular">
                {data.used} of {data.maxPerUser}
              </span>
            </div>
            <Meter value={(data.used / Math.max(1, data.maxPerUser)) * 100} color={atLimit ? "bg-red-500" : "bg-blue-600"} />
          </div>
          <div className="text-[13px] text-slate-500">
            Each store: 1 namespace · quota 1 CPU / 1 GiB requested · provisioning timeout {data.timeoutMinutes} min
          </div>
        </div>
      )}

      {!data ? (
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-80 rounded-3xl" />
          ))}
        </div>
      ) : !data.enabled ? (
        <div className="rounded-3xl border border-slate-100 bg-white shadow-card">
          <EmptyState icon={<StoreIcon />} title="Store provisioning is not enabled">An operator can enable it with stores.enabled=true in the Helm values.</EmptyState>
        </div>
      ) : data.stores.length === 0 ? (
        <div className="rounded-3xl border border-slate-100 bg-white shadow-card">
          <EmptyState
            icon={<StoreIcon />}
            title="No extra stores yet"
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus /> Create your first store
              </Button>
            }
          >
            The main store is always connected as the WooCommerce server. Stores you create here are added next to it.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {data.stores.map((s) => (
            <StoreCard
              key={s.id}
              store={s}
              canManage={isAdmin || s.ownerId === user?.id}
              onDelete={() => setDeleting(s)}
              onRetry={() => retry.mutate(s)}
              retrying={retry.isPending && retry.variables?.id === s.id}
            />
          ))}
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create a store"
        description="Provisions WordPress, WooCommerce, a database and an MCP server in a new namespace. Usually ready in 5–10 minutes."
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={slug.length < 3}>
              Create store
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (slug.length >= 3) create.mutate();
          }}
        >
          <FormField label="Store name" htmlFor="store-name" hint="e.g. Mumbai, Festive Sale, Kids">
            <Input id="store-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus placeholder="Mumbai" />
          </FormField>
          {slug.length >= 3 && (
            <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-[13px]">
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Storefront</span>
                <code className="font-semibold text-slate-800">
                  {slug}.{host ? host.hostname.split(".").slice(1).join(".") : "localtest.me"}
                  {host?.port ? `:${host.port}` : ""}
                </code>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Namespace</span>
                <code className="font-semibold text-slate-800">store-{slug}</code>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">MCP tools</span>
                <code className="font-semibold text-slate-800">{slug}__list_orders, …</code>
              </div>
            </div>
          )}
          {create.isError && <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700">{(create.error as Error).message}</p>}
        </form>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Its MCP tools disappear from the gateway immediately, then its namespace is removed together with the database, volumes, Secrets and Ingress. This cannot be undone."
        confirmLabel="Delete store"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </div>
  );
}
