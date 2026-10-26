import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/format";
import { Spinner } from "./misc";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "sm" | "md" | "icon";

const variants: Record<Variant, string> = {
  primary:
    "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-600/20 hover:from-blue-700 hover:to-indigo-700 hover:shadow-lg hover:shadow-blue-600/25",
  secondary: "bg-surface text-ink-2 border border-line-strong shadow-card hover:bg-subtle hover:text-ink",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  danger: "bg-bad text-white shadow-md shadow-red-600/20 hover:bg-red-700",
  "danger-ghost": "text-bad hover:bg-bad-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg [&_svg]:size-3.5",
  md: "h-9 px-4 text-[14px] gap-2 rounded-xl [&_svg]:size-4",
  icon: "h-8 w-8 rounded-lg justify-center [&_svg]:size-4",
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
        "inline-flex items-center font-semibold whitespace-nowrap transition-all duration-150 select-none",
        "disabled:opacity-50 disabled:pointer-events-none [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});
