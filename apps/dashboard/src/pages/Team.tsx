import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, MoreHorizontal, ShieldCheck, User as UserIcon, UserPlus, UserX, UserCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { Badge, Card, CodeLine, ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";
import { Dialog, DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from "@/components/ui/overlay";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { api, type TeamMember } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, relativeTime } from "@/lib/format";

const inviteSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  email: z.string().trim().email("Enter a valid email"),
  role: z.enum(["member", "admin"]),
});

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const form = useForm<z.infer<typeof inviteSchema>>({ resolver: zodResolver(inviteSchema), defaultValues: { name: "", email: "", role: "member" } });

  useEffect(() => {
    if (open) {
      setLink(null);
      form.reset({ name: "", email: "", role: "member" });
    }
  }, [open, form]);

  const invite = useMutation({
    mutationFn: (v: z.infer<typeof inviteSchema>) => api.post<{ inviteUrl: string }>("/users", v),
    onSuccess: (res, v) => {
      setLink({ url: res.inviteUrl, email: v.email });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const onSubmit = form.handleSubmit((v) => invite.mutate(v));
  const errors = form.formState.errors;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={link ? "Invite created" : "Invite a team member"}
      description={link ? `Send this link to ${link.email}. It works once and expires in 7 days.` : "They choose their own password, then create their own API key."}
      footer={
        link ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" onClick={onSubmit} loading={invite.isPending}>
              Create invite
            </Button>
          </>
        )
      }
    >
      {link ? (
        <CodeLine value={link.url} />
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label="Name" htmlFor="inv-name" error={errors.name?.message}>
            <Input id="inv-name" autoFocus {...form.register("name")} />
          </FormField>
          <FormField label="Email" htmlFor="inv-email" error={errors.email?.message}>
            <Input id="inv-email" type="email" {...form.register("email")} />
          </FormField>
          <FormField label="Role" htmlFor="inv-role" hint="Admins manage servers, members and keys. Members use tools.">
            <Select id="inv-role" {...form.register("role")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </FormField>
          {invite.isError && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{(invite.error as Error).message}</p>}
          <button type="submit" className="hidden" />
        </form>
      )}
    </Dialog>
  );
}

export function TeamPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reinvite, setReinvite] = useState<{ url: string; email: string } | null>(null);
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: TeamMember[] }>("/users") });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: string; status?: string }) => api.patch(`/users/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      toast.success("Member updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const newInvite = useMutation({
    mutationFn: (m: TeamMember) => api.post<{ inviteUrl: string }>(`/users/${m.id}/invite`),
    onSuccess: (res, m) => setReinvite({ url: res.inviteUrl, email: m.email }),
    onError: (e) => toast.error((e as Error).message),
  });

  const users = q.data?.users ?? [];

  return (
    <>
      <PageHeader
        title="Team"
        description="Admins manage servers, people and keys. Members use tools."
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite member
          </Button>
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Card>
        {q.isLoading ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th className="text-right">Active keys</Th>
                <Th className="hidden md:table-cell">Last activity</Th>
                <Th className="w-10" />
              </tr>
            </THead>
            <tbody>
              {users.map((m) => (
                <Tr key={m.id}>
                  <Td>
                    <div className="font-medium">
                      {m.name}
                      {m.id === user?.id && <span className="ml-1.5 text-[12px] font-normal text-faint">you</span>}
                    </div>
                    <div className="text-[12px] text-muted">{m.email}</div>
                  </Td>
                  <Td>
                    {m.role === "admin" ? (
                      <Badge tone="accent">
                        <ShieldCheck className="size-3" /> Admin
                      </Badge>
                    ) : (
                      <Badge>Member</Badge>
                    )}
                  </Td>
                  <Td>
                    {m.status === "active" && <Badge tone="ok">Active</Badge>}
                    {m.status === "invited" && <Badge tone="warn">Invited</Badge>}
                    {m.status === "disabled" && <Badge tone="bad">Disabled</Badge>}
                  </Td>
                  <Td className="text-right tabular">{m.active_keys}</Td>
                  <Td className="hidden text-muted md:table-cell" title={dateTime(m.last_activity_at)}>
                    {m.last_activity_at ? relativeTime(m.last_activity_at) : m.last_login_at ? `Signed in ${relativeTime(m.last_login_at)}` : "—"}
                  </Td>
                  <Td className="pr-2">
                    <DropdownMenu>
                      <DropdownTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${m.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownTrigger>
                      <DropdownContent>
                        {m.status !== "disabled" && (
                          <DropdownItem onSelect={() => navigate(`/keys?issueTo=${m.id}`)}>
                            <KeyRound /> Issue API key
                          </DropdownItem>
                        )}
                        {m.status === "invited" && (
                          <DropdownItem onSelect={() => newInvite.mutate(m)}>
                            <Link2 /> New invite link
                          </DropdownItem>
                        )}
                        {m.id !== user?.id && (
                          <>
                            <DropdownItem onSelect={() => update.mutate({ id: m.id, role: m.role === "admin" ? "member" : "admin" })}>
                              {m.role === "admin" ? <UserIcon /> : <ShieldCheck />} {m.role === "admin" ? "Change to member" : "Make admin"}
                            </DropdownItem>
                            <DropdownSeparator />
                            {m.status === "disabled" ? (
                              <DropdownItem onSelect={() => update.mutate({ id: m.id, status: "active" })}>
                                <UserCheck /> Re-enable
                              </DropdownItem>
                            ) : (
                              m.status === "active" && (
                                <DropdownItem destructive onSelect={() => update.mutate({ id: m.id, status: "disabled" })}>
                                  <UserX /> Disable account
                                </DropdownItem>
                              )
                            )}
                          </>
                        )}
                      </DropdownContent>
                    </DropdownMenu>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-faint">Disabling an account signs the person out and makes all of their API keys stop working.</p>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <Dialog
        open={Boolean(reinvite)}
        onOpenChange={(o) => !o && setReinvite(null)}
        title="New invite link"
        description={`Send this to ${reinvite?.email}. Earlier links stop working.`}
        footer={
          <Button variant="primary" onClick={() => setReinvite(null)}>
            Done
          </Button>
        }
      >
        {reinvite && <CodeLine value={reinvite.url} />}
      </Dialog>
    </>
  );
}
