import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { Logo } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/form";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[340px]">
          <Logo className="mb-6 size-7" />
          <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
      <footer className="px-6 py-4 text-[12px] text-faint">Urumi MCP Gateway</footer>
    </div>
  );
}

export function LoginPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  if (user) return <Navigate to="/" replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post("/auth/login", values);
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    }
  });

  return (
    <AuthLayout title="Sign in to Urumi" subtitle="Use the account your administrator invited you to.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
        </FormField>
        <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
        </FormField>
        {error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" className="w-full justify-center" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
