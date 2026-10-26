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
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 px-4 py-12">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-1/4 left-1/4 size-64 rounded-full bg-blue-200 opacity-40 mix-blend-multiply blur-3xl" />
        <div className="absolute top-1/3 right-1/4 size-64 rounded-full bg-purple-200 opacity-40 mix-blend-multiply blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 size-64 rounded-full bg-indigo-200 opacity-40 mix-blend-multiply blur-3xl" />
      </div>
      <div className="relative w-full max-w-md rounded-3xl border border-white/60 bg-white/85 p-8 shadow-2xl shadow-indigo-900/10 backdrop-blur-sm sm:p-10">
        <Logo className="mx-auto mb-6 size-16 rounded-3xl [&_svg]:size-8" />
        <h1 className="bg-gradient-to-r from-slate-900 to-slate-600 bg-clip-text text-center text-[26px] font-bold text-transparent">{title}</h1>
        {subtitle && <p className="mt-2 text-center text-[14px] text-slate-600">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </div>
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
    <AuthLayout title="Urumi MCP Gateway" subtitle="Sign in to manage your team's MCP servers, stores and tools.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
        </FormField>
        <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
        </FormField>
        {error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" className="h-11 w-full justify-center rounded-xl" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
