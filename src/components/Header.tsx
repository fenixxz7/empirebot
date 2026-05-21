import { useState } from "react";
import type { InstanceState } from "@shared/types";

export function Header({
  instance,
  isAdmin = false,
  onLogout,
}: {
  instance: InstanceState | null;
  isAdmin?: boolean;
  onLogout?: () => void;
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const connected = !!instance?.connected;
  const running = !!instance?.running;

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      onLogout?.();
    }
  }

  return (
    <div className="card px-4 py-3 sm:px-5 sm:py-4">
      {/* Row 1 — identity + logout */}
      <div className="flex items-center gap-3">
        <EmpireLogo />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-xl sm:text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 bg-clip-text text-transparent leading-none">
              EMPIRE
            </span>
            <span className="hidden sm:inline text-[10px] uppercase tracking-[0.25em] text-slate-500">
              Painel de Controle
            </span>
          </div>
          {/* Status pills */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={connected ? "pill-ok" : "pill-stop"}>
              <Dot className={connected ? "bg-ok" : "bg-danger"} />
              {connected
                ? instance?.user_handle
                  ? `Conectado · ${instance.user_handle}`
                  : "Conectado"
                : "Desconectado"}
            </span>
            <span className={running ? "pill-run" : "pill-stop"}>
              <Dot className={running ? "bg-emerald-400" : "bg-danger"} />
              {running ? "Rodando" : "Parado"}
            </span>
            {instance && instance.tokens_total > 0 && (
              <span className="pill bg-white/[0.04] text-slate-400 ring-1 ring-white/[0.08]">
                {instance.tokens_active}/{instance.tokens_total} tokens
              </span>
            )}
          </div>
        </div>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          title="Sair"
          className="shrink-0 text-[11px] text-slate-500 hover:text-rose-400 transition-colors p-2 rounded-lg hover:bg-white/[0.04] disabled:opacity-40"
        >
          ⏻
        </button>
      </div>

      {/* Row 2 — nav links (only if isAdmin) */}
      {isAdmin && (
        <div className="mt-3 pt-3 border-t border-white/[0.05] flex flex-wrap items-center gap-1.5">
          <NavLink href="/contas" color="cyan">👤 Contas</NavLink>
          <NavLink href="/acessos" color="amber">🔑 Acessos</NavLink>
          <NavLink href="/auditoria" color="violet">📋 Auditoria</NavLink>
          <NavLink href="/stats" color="violet">📊 Stats</NavLink>
        </div>
      )}
    </div>
  );
}

function NavLink({
  href,
  color,
  children,
}: {
  href: string;
  color: "cyan" | "amber" | "violet";
  children: React.ReactNode;
}) {
  const cls = {
    cyan:   "text-cyan-400 hover:text-cyan-300 border-cyan-500/20 hover:border-cyan-400/40",
    amber:  "text-amber-400 hover:text-amber-300 border-amber-500/20 hover:border-amber-400/40",
    violet: "text-violet-400 hover:text-violet-300 border-violet-500/20 hover:border-violet-400/40",
  }[color];
  return (
    <a
      href={href}
      className={`text-[10px] uppercase tracking-widest transition-colors border rounded-lg px-2.5 py-1 ${cls}`}
    >
      {children}
    </a>
  );
}

function Dot({ className = "" }: { className?: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${className}`} />;
}

function EmpireLogo() {
  return (
    <div className="shrink-0 w-9 h-9 sm:w-10 sm:h-10">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <defs>
          <linearGradient id="shieldGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fbbf24" />
            <stop offset="50%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#d97706" />
          </linearGradient>
          <linearGradient id="shieldGloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M24 3L6 10v14c0 9.5 7.5 18.4 18 21 10.5-2.6 18-11.5 18-21V10L24 3z" fill="url(#shieldGrad)" />
        <path d="M24 3L6 10v14c0 1 .05 2 .15 3L24 10.5 41.85 27c.1-1 .15-2 .15-3V10L24 3z" fill="url(#shieldGloss)" />
        <text x="24" y="31" textAnchor="middle" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="22" fill="#1a0a00" letterSpacing="-1">E</text>
      </svg>
    </div>
  );
}
