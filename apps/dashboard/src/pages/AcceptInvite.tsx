import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/form";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { AuthLayout } from "./Login";

const schema = z
  .object({
    password: z.string().min(10, "Use at least 10 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match" });

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<{ email: string; name: string }>(`/auth/invite?token=${encodeURIComponent(token)}`),
    enabled: token.length > 0,
    retry: false,
  });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });

  if (!token || invite.isError) {
    return (
      <AuthLayout title="Invite not valid" subtitle="This invite link is invalid, already used, or expired. Ask an administrator for a new one.">
        <Link to="/login" className="text-[13px] font-medium text-accent hover:underline">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }
  if (invite.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }

  const onSubmit = form.handleSubmit(async ({ password }) => {
    setError(null);
    try {
      await api.post("/auth/accept-invite", { token, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/keys", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    }
  });

  return (
    <AuthLayout title={`Welcome, ${invite.data!.name}`} subtitle={<>Choose a password for <span className="font-medium text-ink">{invite.data!.email}</span>.</>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message} hint="At least 10 characters.">
          <Input id="password" type="password" autoComplete="new-password" autoFocus {...form.register("password")} />
        </FormField>
        <FormField label="Confirm password" htmlFor="confirm" error={form.formState.errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" {...form.register("confirm")} />
        </FormField>
        {error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" className="w-full justify-center" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
