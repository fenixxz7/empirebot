import { useCallback, useEffect, useRef, useState } from "react";
import type { InstanceState } from "@shared/types";
import { api } from "@/lib/api";
import { TabNav, type MainTab } from "@/components/TabNav";
import { ControlPanel } from "@/components/ControlPanel";
import { StatsGrid } from "@/components/StatsGrid";
import { ConfigForm } from "@/components/ConfigForm";
import { LogsConsole } from "@/components/LogsConsole";
import { BlacklistPanel } from "@/components/BlacklistPanel";
import { SendErrorsPanel } from "@/components/SendErrorsPanel";
import { Accordion } from "@/components/Accordion";
import OrgJoiner from "@/pages/OrgJoiner";

export function App({ isAdmin = false, restricted: restrictedProp = false, onLogout }: { isAdmin?: boolean; restricted?: boolean; onLogout?: () => void }) {
  const [instances, setInstances] = useState<InstanceState[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<MainTab>("fila");
  const [loggingOut, setLoggingOut] = useState(false);
  const [restricted, setRestricted] = useState(restrictedProp);
  const wsRefs = useRef<Map<number, WebSocket>>(new Map());

  const instance = instances[activeIdx] ?? null;
  const connected = !!instance?.connected;
  const running = !!instance?.running;

  // Busca o flag restricted direto da API — independente da cadeia de props
  // para garantir que o tab BOT ORG suma mesmo sem HMR completo
  useEffect(() => {
    fetch("/api/auth/check")
      .then(r => r.json())
      .then((d: { restricted?: boolean }) => {
        if (d.restricted) setRestricted(true);
      })
      .catch(() => {/* noop */});
  }, []);

  async function reload() {
    try {
      const list = await api<InstanceState[]>("/api/instances");
      const filtered = isAdmin ? list : list.filter(i => i.name !== "BOT X");
      setInstances(filtered);
    } catch (e) {
      console.error(e);
    }
  }

  const connectWs = useCallback((inst: InstanceState) => {
    if (wsRefs.current.has(inst.id)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${inst.id}`);
    wsRefs.current.set(inst.id, ws);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "stats") {
          const p = msg.payload;
          setInstances((prev) =>
            prev.map((item) =>
              item.id === inst.id
                ? {
                    ...item,
                    running: p.running ?? item.running,
                    connected: p.connected ?? item.connected,
                    user_handle: p.user_handle ?? item.user_handle,
                    uptime_seconds: p.uptime_seconds ?? item.uptime_seconds,
                    next_rotation_seconds:
                      p.next_rotation_seconds ?? item.next_rotation_seconds,
                    stats: {
                      entradas: p.entradas ?? item.stats.entradas,
                      na_fila: p.na_fila ?? item.stats.na_fila,
                      partidas: p.partidas ?? item.stats.partidas,
                      dms: p.dms ?? item.stats.dms,
                      bloqueadas: p.bloqueadas ?? item.stats.bloqueadas,
                      msgs_enviadas: p.msgs_enviadas ?? item.stats.msgs_enviadas,
                    },
                  }
                : item,
            ),
          );
        }
      } catch { /* noop */ }
    };

    ws.onclose = () => {
      wsRefs.current.delete(inst.id);
      setTimeout(() => {
        if (wsRefs.current.has(inst.id)) return;
        connectWs(inst);
      }, 3000);
    };
    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    for (const inst of instances) connectWs(inst);
  }, [instances.map((i) => i.id).join(",")]);

  useEffect(() => {
    return () => {
      for (const ws of wsRefs.current.values()) ws.close();
    };
  }, []);

  async function toggle() {
    if (!instance) return;
    const path = instance.running
      ? `/api/instances/${instance.id}/stop`
      : `/api/instances/${instance.id}/start`;
    await api(path, { method: "POST" });
    reload();
  }

  async function resetStats() {
    if (!instance) return;
    await api(`/api/instances/${instance.id}/reset-stats`, { method: "POST" });
    reload();
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      onLogout?.();
    }
  }

  return (
    <div className="min-h-screen px-3 sm:px-5 lg:px-8 py-4 sm:py-6">
      <div className="mx-auto max-w-4xl space-y-2.5">

        {/* ── Main header card ───────────────────────────────────── */}
        <div
          className="card px-4 py-4 sm:px-6 sm:py-5"
          style={{ background: "linear-gradient(135deg, #0f2051 0%, #0a1430 60%, #070d1f 100%)" }}
        >
          <div className="flex items-center gap-4">
            {/* Logo */}
            <ImperiunsLogo />

            {/* Brand */}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-slate-500 uppercase tracking-[0.22em] leading-none mb-0.5">
                Painel de Controle
              </p>
              <p className="text-xl sm:text-2xl font-black tracking-tight leading-none bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 bg-clip-text text-transparent">
                EMPIRE
              </p>
            </div>

            {/* Logout */}
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              title="Sair"
              className="shrink-0 text-[11px] text-slate-500 hover:text-rose-400 transition-colors p-2 rounded-lg hover:bg-white/[0.04] disabled:opacity-40"
            >
              ⏻
            </button>
          </div>

          {/* Tabs */}
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <TabNav active={activeTab} onChange={setActiveTab} hideOrg={restricted} />

            {/* Status pills — only for BOT FILA */}
            {activeTab === "fila" && (
              <div className="flex items-center gap-1.5">
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
            )}
          </div>

          {/* Admin nav links */}
          {isAdmin && (
            <div className="mt-3 pt-3 border-t border-white/[0.05] flex flex-wrap items-center gap-1.5">
              <NavLink href="/contas" color="cyan">👤 Contas</NavLink>
              <NavLink href="/acessos" color="amber">🔑 Acessos</NavLink>
              <NavLink href="/auditoria" color="violet">📋 Auditoria</NavLink>
              <NavLink href="/stats" color="violet">📊 Stats</NavLink>
            </div>
          )}
        </div>

        {/* ── BOT FILA content ───────────────────────────────────── */}
        {activeTab === "fila" && (
          <>
            {/* Instance tabs */}
            {instances.length > 1 && (
              <div className="flex gap-1.5">
                {instances.map((inst, idx) => (
                  <button
                    key={inst.id}
                    onClick={() => setActiveIdx(idx)}
                    className={[
                      "flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all",
                      idx === activeIdx ? "tab-active" : "tab-inactive card",
                    ].join(" ")}
                  >
                    {inst.name}
                    {inst.running && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Control + Stats */}
            <div className="grid sm:grid-cols-[auto_1fr] gap-2.5">
              <ControlPanel instance={instance} onToggle={toggle} />
              <StatsGrid instance={instance} onResetStats={resetStats} />
            </div>

            {/* Acordeões */}
            {instance && (
              <>
                <Accordion
                  title="Configuração"
                  icon={<GearIcon className="w-4 h-4" />}
                  defaultOpen={false}
                >
                  <ConfigForm
                    instanceId={instance.id}
                    running={instance.running}
                    onSaved={reload}
                    isAdmin={isAdmin}
                  />
                </Accordion>

                <Accordion
                  title="Blacklist de orgs por token"
                  icon={<ShieldIcon className="w-4 h-4" />}
                  danger
                  defaultOpen={false}
                >
                  <BlacklistPanel instanceId={instance.id} />
                </Accordion>

                <Accordion
                  title="Erros de envio de mensagem por org"
                  icon={<AlertIcon className="w-4 h-4" />}
                  danger
                  defaultOpen={false}
                >
                  <SendErrorsPanel instanceId={instance.id} />
                </Accordion>

                <Accordion
                  title="Logs"
                  icon={<TerminalIcon className="w-4 h-4" />}
                  defaultOpen={true}
                >
                  <div className="px-4 sm:px-5 py-4">
                    <LogsConsole instanceId={instance.id} />
                  </div>
                </Accordion>
              </>
            )}
          </>
        )}

        {/* ── BOT ORG content ────────────────────────────────────── */}
        {activeTab === "org" && <OrgJoiner isAdmin={isAdmin} />}

        <p className="text-center text-[11px] text-slate-600 pb-6 pt-1">
          Use por sua conta e risco · Selfbots violam os Termos de Serviço do Discord.
        </p>
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────── */
function Dot({ className = "" }: { className?: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${className}`} />;
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

/* ── IMPERIUNS logo — blue rounded square + crown ───────────────── */
function ImperiunsLogo() {
  return (
    <div className="shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-xl overflow-hidden"
      style={{ background: "linear-gradient(145deg, #1a3a8f, #0d2260)" }}>
      <svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
        <path
          d="M8 38 L14 20 L20 30 L28 14 L36 30 L42 20 L48 38 Z"
          fill="white"
          fillOpacity="0.95"
        />
        <rect x="8" y="39" width="40" height="5" rx="2" fill="white" fillOpacity="0.95" />
      </svg>
    </div>
  );
}

/* ── Inline icons ─────────────────────────────────────────────────── */
function GearIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function ShieldIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function AlertIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function SparkleIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
    </svg>
  );
}
function TerminalIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}
