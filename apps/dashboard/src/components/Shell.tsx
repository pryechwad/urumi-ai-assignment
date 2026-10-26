import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
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

const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <LayoutDashboard /> },
  { to: "/chat", label: "Chat", icon: <MessageSquare /> },
  { to: "/stores", label: "Stores", icon: <Store /> },
  { to: "/servers", label: "Servers", icon: <Server /> },
  { to: "/tools", label: "Tools", icon: <Wrench /> },
  { to: "/audit", label: "Audit log", icon: <ScrollText /> },
  { to: "/keys", label: "API keys", icon: <KeyRound /> },
  { to: "/team", label: "Team", icon: <Users />, adminOnly: true },
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
        <div className="bg-gradient-to-r from-slate-900 to-slate-600 bg-clip-text text-[18px] font-bold text-transparent">Urumi MCP Gateway</div>
      </div>
    </div>
  );
}

/** "● 3/3 servers connected · app.localtest.me:8088" from live server status. */
function LiveLine() {
  const meta = useMeta();
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.get<{ servers: ServerT[] }>("/servers"), refetchInterval: 10_000 });
  const list = servers.data?.servers ?? [];
  const enabled = list.filter((s) => s.enabled);
  const up = enabled.filter((s) => s.status === "connected").length;
  const healthy = enabled.length > 0 && up === enabled.length;
  return (
    <div className="flex items-center gap-2 text-[12px] whitespace-nowrap">
      {servers.data && (
        <span className={cn("flex items-center gap-1.5 font-semibold", healthy ? "text-emerald-600" : "text-amber-600")}>
          <span className={cn("size-2 rounded-full", healthy ? "animate-pulse bg-emerald-500" : "bg-amber-500")} />
          {up}/{enabled.length} servers connected
        </span>
      )}
      {meta.data && (
        <span className="hidden items-center gap-2 2xl:flex">
          <span className="size-1 rounded-full bg-slate-300" />
          <span className="text-slate-500">{new URL(meta.data.publicUrl).host}</span>
        </span>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownTrigger className="flex items-center gap-3 rounded-xl border border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100 px-3 py-2 shadow-sm transition-all hover:from-slate-100 hover:to-slate-200 hover:shadow-md">
        <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-[13px] font-bold text-white">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden text-left md:block">
          <span className="block text-[13px] font-semibold whitespace-nowrap text-slate-900">{user.name}</span>
          <span className="block text-[11px] text-slate-500 capitalize">{user.role}</span>
        </span>
        <ChevronDown className="size-4 text-slate-400" />
      </DropdownTrigger>
      <DropdownContent>
        <DropdownLabel>{user.email}</DropdownLabel>
        <DropdownSeparator />
        <DropdownItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

function NavPills({ onNavigate, vertical }: { onNavigate?: () => void; vertical?: boolean }) {
  const { isAdmin } = useAuth();
  return (
    <nav className={cn(vertical ? "flex flex-col gap-1" : "flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1")}>
      {NAV.filter((n) => !n.adminOnly || isAdmin).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold whitespace-nowrap transition-all duration-150 [&_svg]:size-4",
              isActive ? "border border-blue-100 bg-white text-blue-600 shadow-md" : "border border-transparent text-slate-600 hover:bg-white/60 hover:text-slate-900",
            )
          }
        >
          {item.icon}
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/95 shadow-lg shadow-slate-900/[0.03] backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <Logo />
            <div className="min-w-0">
              <div className="truncate bg-gradient-to-r from-slate-900 to-slate-600 bg-clip-text text-[19px] font-bold text-transparent">Urumi MCP Gateway</div>
              <div className="hidden sm:block">
                <LiveLine />
              </div>
            </div>
          </Link>
          <div className="hidden xl:block">
            <NavPills />
          </div>
          <div className="flex items-center gap-2">
            <UserMenu />
            <button onClick={() => setOpen((o) => !o)} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 xl:hidden" aria-label="Toggle navigation">
              {open ? <X className="size-5" /> : <MenuIcon className="size-5" />}
            </button>
          </div>
        </div>
        {open && (
          <div className="border-t border-slate-100 px-4 py-3 xl:hidden">
            <NavPills vertical onNavigate={() => setOpen(false)} />
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
