import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Server } from "@/lib/api";

/** Mutations shared by the servers list and the server detail page. */
export function useServerActions() {
  const qc = useQueryClient();
  const invalidate = (id?: string) => {
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: ["tools"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
    if (id) void qc.invalidateQueries({ queryKey: ["server", id] });
  };

  const toggle = useMutation({
    mutationFn: (s: Server) => api.patch<{ server: Server }>(`/servers/${s.id}`, { enabled: !s.enabled }),
    onSuccess: ({ server }) => {
      invalidate(server.id);
      toast.success(server.enabled ? `${server.name} enabled` : `${server.name} disabled`, {
        description: server.enabled ? "Its tools are available again." : "Its tools are hidden and calls are rejected.",
      });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const refresh = useMutation({
    mutationFn: (s: Server) => api.post<{ server: Server }>(`/servers/${s.id}/refresh`),
    onSuccess: ({ server }) => {
      invalidate(server.id);
      if (server.status === "connected") toast.success(`${server.name} is connected`, { description: `${server.toolCount} tools.` });
      else toast.error(`${server.name} is unreachable`, { description: server.statusDetail ?? undefined });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: (s: Server) => api.del(`/servers/${s.id}`),
    onSuccess: (_d, s) => {
      invalidate();
      toast.success(`${s.name} removed`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return { toggle, refresh, remove };
}
