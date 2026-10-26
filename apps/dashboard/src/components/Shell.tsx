import {
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
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth, useMeta } from "@/lib/auth";
import { cn } from "@/lib/format";
import { CopyButton } from "./ui/misc";
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
      { to: "/chat", label: "Chat", icon: <MessageSquare /> },
    ],
  },
  {
    title: "Gateway",
    items: [
      { to: "/servers", label: "Servers", icon: <Server /> },
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

// Breadcrumb labels for the top bar.
const crumbs: Array<[RegExp, string[]]> = [
  [/^\/$/, ["Overview"]],
  [/^\/chat/, ["Chat"]],
  [/^\/servers\/.+/, ["Gateway", "Servers", "Details"]],
  [/^\/servers/, ["Gateway", "Servers"]],
  [/^\/tools/, ["Gateway", "Tools"]],
  [/^\/audit/, ["Gateway", "Audit log"]],
  [/^\/keys/, ["Access", "API keys"]],
  [/^\/team/, ["Access", "Team"]],
];

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5.5 shrink-0", className)} aria-hidden>
      <rect width="24" height="24" rx="5.5" fill="var(--color-ink)" />
      <path d="M7.25 7.5v4.75a4.75 4.75 0 0 0 9.5 0V7.5" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Logo />
      <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">Urumi</span>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, isAdmin, signOut } = useAuth();
  const meta = useMeta();
  const host = meta.data ? new URL(meta.data.publicUrl).host : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 px-4">
        <Wordmark />
        <span className="rounded-[4px] border border-line px-1 text-2xs text-muted">Gateway</span>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 pt-2">
        {sections.map((section, i) => {
          const items = section.items.filter((it) => !it.adminOnly || isAdmin);
          if (!items.length) return null;
          return (
            <div key={i}>
              {section.title && <div className="mb-1 px-2 text-2xs font-medium text-faint">{section.title}</div>}
              <ul className="space-y-px">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === "/"}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex h-7.5 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors [&_svg]:size-[15px] [&_svg]:stroke-[1.75]",
                          isActive ? "bg-hover font-medium text-ink [&_svg]:text-ink" : "text-ink-2 hover:bg-hover/70 hover:text-ink [&_svg]:text-muted",
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

      {host && (
        <div className="mx-2.5 mb-2 rounded-md px-2 py-1.5 text-2xs text-muted">
          <div className="text-faint">Connected to</div>
          <div className="truncate font-mono text-ink-2">{host}</div>
        </div>
      )}

      {user && (
        <div className="border-t border-line p-2">
          <DropdownMenu>
            <DropdownTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-hover">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-white">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{user.name}</span>
                <span className="block truncate text-2xs text-muted">{user.email}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-faint" />
            </DropdownTrigger>
            <DropdownContent align="start">
              <DropdownLabel>Signed in as {user.role}</DropdownLabel>
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

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { pathname } = useLocation();
  const meta = useMeta();
  const trail = crumbs.find(([re]) => re.test(pathname))?.[1] ?? [];
  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button onClick={onMenu} className="-ml-1 rounded-md p-1 text-ink-2 hover:bg-hover lg:hidden" aria-label="Open navigation">
        <MenuIcon className="size-4.5" />
      </button>
      <Link to="/" className="lg:hidden">
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
          <rect width="24" height="24" rx="5.5" fill="var(--color-ink)" />
          <path d="M7.25 7.5v4.75a4.75 4.75 0 0 0 9.5 0V7.5" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" />
        </svg>
      </Link>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {trail.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5 truncate">
            {i > 0 && <span className="text-faint">/</span>}
            <span className={i === trail.length - 1 ? "font-medium text-ink" : "text-muted"}>{c}</span>
          </span>
        ))}
      </nav>
      {meta.data && (
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <span className="text-[12px] text-muted">MCP endpoint</span>
          <code className="rounded-[5px] border border-line bg-surface px-2 py-0.5 text-[12px] text-ink-2">{meta.data.mcpUrl}</code>
          <CopyButton value={meta.data.mcpUrl} label="Copy MCP endpoint" iconOnly />
        </div>
      )}
    </header>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh lg:pl-56">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 border-r border-line bg-canvas lg:block">
        <Sidebar />
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 bg-canvas shadow-pop">
            <button onClick={() => setOpen(false)} className="absolute top-3 right-3 rounded-md p-1 text-muted hover:bg-hover" aria-label="Close navigation">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <TopBar onMenu={() => setOpen(true)} />
      <main className="mx-auto w-full max-w-[1200px] px-4 py-7 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
