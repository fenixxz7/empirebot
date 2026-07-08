import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import Stats from "./pages/Stats";
import Login from "./pages/Login";
import AccessKeys from "./pages/AccessKeys";
import AuditLog from "./pages/AuditLog";
import Contas from "./pages/Contas";
import "./index.css";

type AuthState = { status: "loading" } | { status: "unauthenticated" } | { status: "authenticated"; isAdmin: boolean; restricted: boolean };

function Root() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    fetch("/api/auth/check")
      .then(r => r.json())
      .then((data: { authenticated: boolean; is_admin: boolean; restricted: boolean }) => {
        setAuth(data.authenticated
          ? { status: "authenticated", isAdmin: !!data.is_admin, restricted: !!data.restricted }
          : { status: "unauthenticated" }
        );
      })
      .catch(() => setAuth({ status: "unauthenticated" }));
  }, []);

  if (auth.status === "loading") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#0f1117",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#6b7280",
        fontFamily: "Inter, sans-serif",
        fontSize: 14,
      }}>
        Carregando...
      </div>
    );
  }

  if (auth.status === "unauthenticated") {
    return <Login onLogin={() => {
      fetch("/api/auth/check").then(r => r.json()).then((data: { authenticated: boolean; is_admin: boolean; restricted: boolean }) => {
        setAuth({ status: "authenticated", isAdmin: !!data.is_admin, restricted: !!data.restricted });
      });
    }} />;
  }

  function handleLogout() {
    setAuth({ status: "unauthenticated" });
  }

  const path = window.location.pathname;
  if (path.startsWith("/stats")) return <Stats />;
  if (path.startsWith("/contas")) return <Contas />;
  if (path.startsWith("/acessos")) {
    return auth.isAdmin ? <AccessKeys /> : <App isAdmin={false} onLogout={handleLogout} />;
  }
  if (path.startsWith("/auditoria")) {
    return auth.isAdmin ? <AuditLog /> : <App isAdmin={false} onLogout={handleLogout} />;
  }
  return <App isAdmin={auth.isAdmin} restricted={auth.restricted} onLogout={handleLogout} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
