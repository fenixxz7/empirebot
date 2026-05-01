import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import Stats from "./pages/Stats";
import Messages from "./pages/Messages";
import Login from "./pages/Login";
import "./index.css";

function Root() {
  const [authState, setAuthState] = useState<"loading" | "authenticated" | "unauthenticated">("loading");

  useEffect(() => {
    fetch("/api/auth/check")
      .then(r => r.json())
      .then((data: { authenticated: boolean }) => {
        setAuthState(data.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => setAuthState("unauthenticated"));
  }, []);

  if (authState === "loading") {
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

  if (authState === "unauthenticated") {
    return <Login onLogin={() => setAuthState("authenticated")} />;
  }

  const path = window.location.pathname;
  const isStats = path.startsWith("/stats");
  const isMessages = path.startsWith("/messages");

  return isStats ? <Stats /> : isMessages ? <Messages /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
