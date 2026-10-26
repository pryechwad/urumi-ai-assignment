import {
  Boxes,
  ChevronsUpDown,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  MessageSquare,
  ScrollText,
  Server,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/format";
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownTrigger } from "./ui/overlay";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
}

const sections: Array<{ title?: string; items: NavItem[] }> = [
  {
    items: [
      { to: "/", label: "Overview", icon: <LayoutGrid /> },
      { to: "/chat", label: "Chat agent", icon: <MessageSquare /> },
    ],
  },
  {
    title: "Gateway",
    items: [
      { to: "/servers", label: "MCP servers", icon: <Server /> },
      { to: "/tools", label: "Tools", icon: <Wrench /> },
      { to: "/audit", label: "Audit log", icon: <ScrollText /> },
    ],
  },
  {
    title: "Access",
    items: [
      { to: "/keys", label: "API keys", icon: <KeyRound /> },
      { to: "/team", label: "Team", icon: <Users />, adminOnly: true },
    ],
  },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 32 32" className="size-6.5 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="7" fill="var(--color-accent)" />
        <path d="M9 10v7a7 7 0 0 0 14 0v-7" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <circle cx="16" cy="17" r="2.2" fill="#fff" />
      </svg>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold tracking-[-0.01em] text-ink">Urumi</div>
        <div className="text-2xs text-muted">MCP Gateway</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, isAdmin, signOut } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-3">
        <Wordmark />
      </div>
      <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px]">
        <Boxes className="size-3.5 text-muted" />
        <span className="text-muted">Workspace</span>
        <span className="ml-auto font-medium text-ink">Default</span>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {sections.map((section, i) => {
          const items = section.items.filter((it) => !it.adminOnly || isAdmin);
          if (!items.length) return null;
          return (
            <div key={i}>
              {section.title && <div className="px-2 pb-1 text-2xs font-medium tracking-wide text-faint uppercase">{section.title}</div>}
              <ul className="space-y-px">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === "/"}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors [&_svg]:size-4",
                          isActive ? "bg-surface font-medium text-ink shadow-card ring-1 ring-line [&_svg]:text-accent" : "text-ink-2 hover:bg-hover [&_svg]:text-muted",
                        )
                      }
                    >
                      {item.icon}
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {user && (
        <div className="border-t border-line p-3">
          <DropdownMenu>
            <DropdownTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-hover">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{user.name}</span>
                <span className="block truncate text-2xs text-muted capitalize">{user.role}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-faint" />
            </DropdownTrigger>
            <DropdownContent align="start">
              <DropdownLabel>{user.email}</DropdownLabel>
              <DropdownItem onSelect={() => void signOut()}>
                <LogOut /> Sign out
              </DropdownItem>
            </DropdownContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-canvas lg:block">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
        <Wordmark />
        <button onClick={() => setOpen(true)} className="rounded-md p-1.5 text-ink-2 hover:bg-hover" aria-label="Open navigation">
          <MenuIcon className="size-5" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/25" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 border-r border-line bg-canvas shadow-pop">
            <button onClick={() => setOpen(false)} className="absolute top-3.5 right-3 rounded-md p-1 text-muted hover:bg-hover" aria-label="Close navigation">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        <Outlet />
      </main>
    </div>
  );
}
