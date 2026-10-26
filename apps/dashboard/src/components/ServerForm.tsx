import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api, type Server } from "@/lib/api";
import { Button } from "./ui/button";
import { FormField, Input, Select, Textarea } from "./ui/form";
import { Dialog } from "./ui/overlay";
import { Switch } from "./ui/misc";

const schema = z
  .object({
    name: z.string().trim().min(2, "At least 2 characters").max(60),
    url: z
      .string()
      .trim()
      .url("Enter a full URL, e.g. https://mcp.example.com/mcp")
      .refine((u) => /^https?:\/\//.test(u), "Only http and https are supported"),
    description: z.string().trim().max(300),
    authType: z.enum(["none", "bearer", "header"]),
    headerName: z.string().trim(),
    credential: z.string(),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.authType === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(v.headerName)) {
      ctx.addIssue({ code: "custom", path: ["headerName"], message: "Letters, digits and dashes only" });
    }
  });

type Values = z.infer<typeof schema>;

/** Add or edit an upstream MCP server. Saved credentials are never shown again; leave blank to keep. */
export function ServerFormDialog({ open, onOpenChange, server }: { open: boolean; onOpenChange: (o: boolean) => void; server?: Server }) {
  const qc = useQueryClient();
  const editing = Boolean(server);
  const [replaceCredential, setReplaceCredential] = useState(!editing);
  const form = useForm<Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    setReplaceCredential(!server?.auth.hasCredential);
    form.reset({
      name: server?.name ?? "",
      url: server?.url ?? "",
      description: server?.description ?? "",
      authType: server?.auth.type ?? "none",
      headerName: server?.auth.headerName ?? "X-API-Key",
      credential: "",
      enabled: server?.enabled ?? true,
    });
  }, [open, server, form]);

  const authType = form.watch("authType");
  const save = useMutation({
    mutationFn: async (v: Values) => {
      const needsCredential = v.authType !== "none" && (replaceCredential || !server?.auth.hasCredential);
      if (needsCredential && !v.credential) throw new Error("Enter the credential for this server");
      const payload: Record<string, unknown> = {
        name: v.name,
        url: v.url,
        description: v.description,
        authType: v.authType,
        enabled: v.enabled,
        ...(v.authType === "header" ? { headerName: v.headerName } : {}),
        ...(v.authType !== "none" && v.credential ? { credential: v.credential } : {}),
      };
      return server
        ? api.patch<{ server: Server }>(`/servers/${server.id}`, payload)
        : api.post<{ server: Server }>("/servers", payload);
    },
    onSuccess: ({ server: s }) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server", s.id] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      if (!s.enabled) toast.success(`${s.name} saved (disabled)`);
      else if (s.status === "connected") toast.success(`${s.name} connected`, { description: `${s.toolCount} tools discovered.` });
      else toast.warning(`${s.name} saved, but the gateway could not connect`, { description: s.statusDetail ?? undefined, duration: 8000 });
      onOpenChange(false);
    },
  });

  const errors = form.formState.errors;
  const onSubmit = form.handleSubmit((v) => save.mutate(v));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${server!.name}` : "Add MCP server"}
      description={editing ? "Changes take effect immediately for everyone." : "The server must speak MCP over Streamable HTTP. The gateway connects and discovers its tools when you save."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={onSubmit} loading={save.isPending}>
            {editing ? "Save changes" : "Add and connect"}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" placeholder="e.g. GitHub" aria-invalid={!!errors.name} {...form.register("name")} />
        </FormField>
        <FormField label="MCP endpoint URL" htmlFor="url" error={errors.url?.message} hint={!editing ? "Tools will be exposed as <slug>__<tool>; the slug is derived from the name." : undefined}>
          <Input id="url" placeholder="https://mcp.example.com/mcp" className="font-mono text-[13px]" aria-invalid={!!errors.url} {...form.register("url")} />
        </FormField>
        <FormField label="Description" htmlFor="description" optional error={errors.description?.message}>
          <Textarea id="description" rows={2} placeholder="What this server gives the team" {...form.register("description")} />
        </FormField>

        <div className="rounded-lg border border-line bg-subtle/50 p-3.5">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink">
            <Lock className="size-3.5 text-muted" /> Upstream credential
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Authentication" htmlFor="authType">
              <Select id="authType" {...form.register("authType")}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
              </Select>
            </FormField>
            {authType === "header" && (
              <FormField label="Header name" htmlFor="headerName" error={errors.headerName?.message}>
                <Input id="headerName" className="font-mono text-[13px]" {...form.register("headerName")} />
              </FormField>
            )}
          </div>
          {authType !== "none" && (
            <div className="mt-3">
              {editing && server?.auth.hasCredential && !replaceCredential ? (
                <div className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
                  <span className="text-muted">A credential is stored (encrypted). It is never shown again.</span>
                  <Button size="sm" type="button" onClick={() => setReplaceCredential(true)}>
                    Replace
                  </Button>
                </div>
              ) : (
                <FormField label={authType === "bearer" ? "Token" : "Header value"} htmlFor="credential" hint="Encrypted at rest. Team members never see it.">
                  <Input id="credential" type="password" autoComplete="off" className="font-mono text-[13px]" {...form.register("credential")} />
                </FormField>
              )}
            </div>
          )}
        </div>

        <label className="flex items-center justify-between gap-4 rounded-lg border border-line px-3.5 py-3">
          <span>
            <span className="block text-[13px] font-medium text-ink">Enabled</span>
            <span className="block text-[12px] text-muted">Disabled servers' tools are hidden and calls to them are rejected.</span>
          </span>
          <Switch label="Enabled" checked={form.watch("enabled")} onCheckedChange={(v) => form.setValue("enabled", v)} />
        </label>

        {save.isError && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{(save.error as Error).message}</p>}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
