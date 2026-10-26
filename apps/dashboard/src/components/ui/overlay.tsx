import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/format";
import { Button } from "./button";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[1px] data-[state=open]:animate-[fade-in_120ms_ease-out]" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-lg bg-surface shadow-pop",
            "data-[state=open]:animate-[pop-in_140ms_ease-out]",
            size === "sm" && "max-w-md",
            size === "md" && "max-w-lg",
            size === "lg" && "max-w-2xl",
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
            <div>
              <DialogPrimitive.Title className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-[13px] text-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="-mt-1 -mr-1 rounded-md p-1 text-muted hover:bg-hover hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>}
          {footer && <div className="flex justify-end gap-2 rounded-b-lg border-t border-line bg-canvas px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export const DropdownMenu = Menu.Root;
export const DropdownTrigger = Menu.Trigger;

export function DropdownContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" }) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={4}
        className="z-50 min-w-44 rounded-lg bg-surface p-1 shadow-pop data-[state=open]:animate-[pop-in_100ms_ease-out]"
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function DropdownItem({ children, onSelect, destructive, disabled }: { children: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean }) {
  return (
    <Menu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] outline-none select-none [&_svg]:size-3.5 [&_svg]:text-muted",
        "data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        destructive ? "text-bad [&_svg]:!text-bad" : "text-ink",
      )}
    >
      {children}
    </Menu.Item>
  );
}

export function DropdownSeparator() {
  return <Menu.Separator className="my-1 h-px bg-line" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <Menu.Label className="px-2 py-1.5 text-2xs font-medium tracking-wide text-faint uppercase">{children}</Menu.Label>;
}
