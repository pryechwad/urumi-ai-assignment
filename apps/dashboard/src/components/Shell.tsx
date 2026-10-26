import { useQuery } from "@tanstack/react-query";
import {
  ChevronsUpDown,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  MessageSquare,
  ScrollText,
  Server,
  Store,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api, type Server as ServerT } from "@/lib/api";
import { useAuth, useMeta } from "@/lib/auth";
import { cn } from "@/lib/format";
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger } from "./ui/overlay";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
}

const SECTIONS: Array<{ title?: string; items: NavItem[] }> = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: <LayoutDashboard /> },
      { to: "/chat", label: "Chat agent", icon: <MessageSquare /> },
    ],
  },
  {
    title: "Commerce",
    items: [{ to: "/stores", label: "Stores", icon: <Store /> }],
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

const PAGE_TITLES: Array<[RegExp, string]> = [
  [/^\/$/, "Dashboard"],
  [/^\/chat/, "Chat agent"],
  [/^\/stores/, "Stores"],
  [/^\/servers/, "MCP servers"],
  [/^\/tools/, "Tools"],
  [/^\/audit/, "Audit log"],
  [/^\/keys/, "API keys"],
  [/^\/team/, "Team"],
];

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 shadow-xl shadow-indigo-600/25", className)}>
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
        <path d="M6.5 6v6.5a5.5 5.5 0 0 0 11 0V6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="12" cy="12.5" r="1.6" fill="#fff" />
      </svg>
    </div>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Logo className="size-10" />
      <div className="leading-tight">
        <div className="bg-gradient-to-r from-slate-900 to-slate-600 bg-clip-text text-[17px] font-bold text-transparent">Urumi</div>
        <div className="text-[12px] font-medium text-slate-500">MCP Gateway</div>
      </div>
    </div>
  );
}

/** "● 3/3 servers connected" from live server status. */
function LiveStatus() {
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.get<{ servers: ServerT[] }>("/servers"), refetchInterval: 10_000 });
  if (!servers.data) return null;
  const enabled = servers.data.servers.filter((s) => s.enabled);
  const up = enabled.filter((s) => s.status === "connected").length;
  const healthy = enabled.length > 0 && up === enabled.length;
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold whitespace-nowrap",
        healthy ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700",
      )}
    >
      <span className={cn("size-2 rounded-full", healthy ? "animate-pulse bg-emerald-500" : "bg-amber-500")} />
      {up}/{enabled.length} servers connected
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, isAdmin, signOut } = useAuth();
  const meta = useMeta();
  return (
    <div className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className="flex h-20 items-center px-5">
        <Wordmark />
      </Link>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-3">
        {SECTIONS.map((section, i) => {
          const items = section.items.filter((it) => !it.adminOnly || isAdmin);
          if (!items.length) return null;
          return (
            <div key={i}>
              {section.title && <div className="mb-2 px-3 text-[11px] font-bold tracking-wider text-slate-400 uppercase">{section.title}</div>}
              <ul className="space-y-1">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === "/"}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-semibold transition-all duration-150 [&_svg]:size-[18px]",
                          isActive
                            ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-600/25"
                            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 [&_svg]:text-slate-400",
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

      {meta.data && (
        <div className="mx-3 mb-3 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900 p-4 text-white shadow-lg">
          <div className="text-[11px] font-semibold tracking-wide text-blue-200 uppercase">MCP endpoint</div>
          <div className="mt-1 truncate font-mono text-[12px] font-semibold">{new URL(meta.data.mcpUrl).host}/mcp</div>
          <Link to="/keys" onClick={onNavigate} className="mt-2 inline-block text-[12px] font-semibold text-blue-200 hover:text-white">
            Connect a client →
          </Link>
        </div>
      )}

      {user && (
        <div className="border-t border-slate-100 p-3">
          <DropdownMenu>
            <DropdownTrigger className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-slate-100">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-[14px] font-bold text-white">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-slate-900">{user.name}</span>
                <span className="block truncate text-[12px] text-slate-500 capitalize">{user.role}</span>
              </span>
              <ChevronsUpDown className="size-4 text-slate-400" />
            </DropdownTrigger>
            <DropdownContent align="start">
              <DropdownLabel>{user.email}</DropdownLabel>
              <DropdownSeparator />
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
  const title = PAGE_TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? "";

  return (
    <div className="min-h-dvh bg-canvas lg:pl-68">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-68 border-r border-slate-200/70 bg-white shadow-xl shadow-slate-900/[0.03] lg:block">
        <Sidebar />
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-white shadow-2xl">
            <button onClick={() => setOpen(false)} className="absolute top-6 right-4 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Close navigation">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <button onClick={() => setOpen(true)} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 lg:hidden" aria-label="Open navigation">
            <MenuIcon className="size-5" />
          </button>
          <h2 className="truncate text-[16px] font-bold text-slate-900">{title}</h2>
          <div className="ml-auto">
            <LiveStatus />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
