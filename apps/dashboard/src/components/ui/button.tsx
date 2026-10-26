import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/format";
import { Spinner } from "./misc";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "sm" | "md" | "icon";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover shadow-card border border-accent-hover/40",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-subtle shadow-card",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  danger: "bg-bad text-white hover:bg-bad/90 border border-bad shadow-card",
  "danger-ghost": "text-bad hover:bg-bad-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-8.5 px-3.5 text-sm gap-2 rounded-md",
  icon: "h-8 w-8 rounded-md justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center font-medium whitespace-nowrap transition-colors select-none",
        "disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
});
