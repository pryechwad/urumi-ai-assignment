import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/format";
import { Spinner } from "./misc";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "sm" | "md" | "icon";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-ink-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-subtle hover:border-faint/60",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  danger: "bg-bad text-white hover:bg-bad/90",
  "danger-ghost": "text-bad hover:bg-bad-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-6.5 px-2 text-[12px] gap-1.5 rounded-[5px] [&_svg]:size-3.5",
  md: "h-7.5 px-3 text-[13px] gap-1.5 rounded-md [&_svg]:size-3.5",
  icon: "h-7 w-7 rounded-md justify-center [&_svg]:size-4",
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
        "inline-flex items-center font-medium whitespace-nowrap transition-colors duration-100 select-none",
        "disabled:opacity-45 disabled:pointer-events-none [&_svg]:shrink-0",
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
