import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/format";

const control =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-faint shadow-card transition-colors " +
  "hover:border-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/12 disabled:bg-subtle disabled:text-muted " +
  "aria-[invalid=true]:border-bad aria-[invalid=true]:focus:ring-bad/12";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-8.5", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, "py-2 leading-relaxed", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <div className={cn("relative", className)}>
      <select ref={ref} className={cn(control, "h-8.5 appearance-none pr-8")} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted" />
    </div>
  );
});

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-[13px] font-medium text-ink">
        {label}
        {optional && <span className="text-2xs font-normal text-faint">Optional</span>}
      </label>
      {children}
      {error ? <p className="text-[12px] text-bad">{error}</p> : hint ? <p className="text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}
