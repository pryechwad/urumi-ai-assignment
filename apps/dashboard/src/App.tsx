import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Spinner } from "./components/ui/misc";
import { useAuth } from "./lib/auth";
import { AcceptInvitePage } from "./pages/AcceptInvite";
import { AuditPage } from "./pages/Audit";
import { ChatPage } from "./pages/Chat";
import { KeysPage } from "./pages/Keys";
import { LoginPage } from "./pages/Login";
import { OverviewPage } from "./pages/Overview";
import { ServerDetailPage } from "./pages/ServerDetail";
import { ServersPage } from "./pages/Servers";
import { TeamPage } from "./pages/Team";
import { ToolsPage } from "./pages/Tools";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="servers/:id" element={<ServerDetailPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route
          path="team"
          element={
            <AdminOnly>
              <TeamPage />
            </AdminOnly>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
