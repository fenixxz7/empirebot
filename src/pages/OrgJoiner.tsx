import { useCallback, useEffect, useRef, useState } from "react";
import { TabNav } from "@/components/TabNav";

interface Instance { id: number; name: string; }

interface OrgConfig {
  token_value: string | null;
  nopecha_key: string | null;
  delay_min_ms: number;
  delay_max_ms: number;
  enabled: boolean;
}

interface OrgQueueItem {
  id: number;
  invite_code: string;
  invite_raw: string;
  status: "pending" | "processing" | "done" | "failed";
  result_guild_id: string | null;
  result_guild_name: string | null;
  error_reason: string | null;
  added_at: string;
  processed_at: string | null;
}

interface OrgSnapshot {
  running: boolean;
  startedAt: string | null;
  uptimeMs: number;
  counter: number;
  currentItem: { id: number; invite_code: string; invite_raw: string } | null;
  queueSize: number;
}

interface LogEntry { ts: string; msg: string; }

const DEFAULT_CFG: OrgConfig = {
  token_value: null, nopecha_key: null,
  delay_min_ms: 300000, delay_max_ms: 720000, enabled: false,
};
const DEFAULT_SNAP: OrgSnapshot = {
  running: false, startedAt: null, uptimeMs: 0, counter: 0, currentItem: null, queueSize: 0,
};

function formatUptime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600).toString().padStart(2, "0");
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export default function OrgJoiner() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [cfg, setCfg] = useState<OrgConfig>(DEFAULT_CFG);
  const [snap, setSnap] = useState<OrgSnapshot>(DEFAULT_SNAP);
  const [queue, setQueue] = useState<OrgQueueItem[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inviteInput, setInviteInput] = useState("");
  const [addingInvite, setAddingInvite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [nopechaDraft, setNopechaDraft] = useState("");
  const [delayMinDraft, setDelayMinDraft] = useState("5");
  const [delayMaxDraft, setDelayMaxDraft] = useState("12");
  const [retrying, setRetrying] = useState(false);

  const snapTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const logsBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/instances")
      .then(r => r.json())
      .then((data: Instance[]) => {
        setInstances(data);
        if (data.length > 0) setActiveId(data[0]!.id);
      });
  }, []);

  const loadAll = useCallback(async (id: number) => {
    const [cfgRes, snapRes, queueRes, logsRes] = await Promise.all([
      fetch(`/api/org-joiner/config/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/snapshot/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/queue/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/logs/${id}`).then(r => r.json()),
    ]);
    setCfg(cfgRes);
    setTokenDraft("");
    setNopechaDraft(cfgRes.nopecha_key ?? "");
    setDelayMinDraft(String(Math.round((cfgRes.delay_min_ms ?? 300000) / 60000)));
    setDelayMaxDraft(String(Math.round((cfgRes.delay_max_ms ?? 720000) / 60000)));
    setSnap(snapRes);
    setQueue(Array.isArray(queueRes) ? queueRes : []);
    setLogs(Array.isArray(logsRes) ? logsRes : []);
  }, []);

  const pollSnap = useCallback(async (id: number) => {
    const [snapRes, queueRes, logsRes] = await Promise.all([
      fetch(`/api/org-joiner/snapshot/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/queue/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/logs/${id}`).then(r => r.json()),
    ]);
    setSnap(snapRes);
    setQueue(Array.isArray(queueRes) ? queueRes : []);
    setLogs(Array.isArray(logsRes) ? logsRes : []);
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (activeId === null) return;
    loadAll(activeId);
    if (snapTimerRef.current) clearInterval(snapTimerRef.current);
    snapTimerRef.current = setInterval(() => {
      if (activeIdRef.current !== null) pollSnap(activeIdRef.current);
    }, 3000);
    return () => { if (snapTimerRef.current) clearInterval(snapTimerRef.current); };
  }, [activeId, loadAll, pollSnap]);

  useEffect(() => {
    logsBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  function flash(msg: string) {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2500);
  }

  async function saveCfg() {
    if (activeId === null) return;
    setSaving(true);
    const body: OrgConfig = {
      token_value: tokenDraft.trim() || cfg.token_value,
      nopecha_key: nopechaDraft.trim() || null,
      delay_min_ms: Math.round(Number(delayMinDraft) * 60000),
      delay_max_ms: Math.round(Number(delayMaxDraft) * 60000),
      enabled: cfg.enabled,
    };
    await fetch(`/api/org-joiner/config/${activeId}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    setSaving(false);
    setTokenDraft("");
    setCfg(body);
    flash("Configuração salva!");
  }

  async function toggleEngine() {
    if (activeId === null) return;
    const path = snap.running ? `/api/org-joiner/stop/${activeId}` : `/api/org-joiner/start/${activeId}`;
    await fetch(path, { method: "POST" });
    await pollSnap(activeId);
  }

  async function addInvite() {
    if (!inviteInput.trim() || activeId === null || addingInvite) return;
    setAddingInvite(true);
    const res = await fetch(`/api/org-joiner/queue/${activeId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: inviteInput.trim() }),
    });
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : data;
    if (first?.ok === false) { flash(`Erro: ${first.error}`); }
    else { setInviteInput(""); flash("Servidor adicionado à fila!"); }
    await pollSnap(activeId);
    setAddingInvite(false);
  }

  async function removeItem(qid: number) {
    if (activeId === null) return;
    await fetch(`/api/org-joiner/queue/${activeId}/${qid}`, { method: "DELETE" });
    setQueue(prev => prev.filter(q => q.id !== qid));
  }

  async function retryFailed() {
    if (activeId === null || retrying) return;
    setRetrying(true);
    const res = await fetch(`/api/org-joiner/queue/${activeId}/retry-failed`, { method: "POST" });
    const data = await res.json();
    flash(`${data.retried ?? 0} item(s) reagendado(s).`);
    await pollSnap(activeId);
    setRetrying(false);
  }

  async function clearLogs() {
    if (activeId === null) return;
    await fetch(`/api/org-joiner/logs/${activeId}`, { method: "DELETE" });
    setLogs([]);
  }

  const hasFailed = queue.some(q => q.status === "failed");
  const pendingCount = queue.filter(q => q.status === "pending").length;
  const canStart = !snap.running && pendingCount > 0;

  const tokenConfigured = !!(cfg.token_value && cfg.token_value.trim().length > 0);

  return (
    <div className="min-h-screen px-3 sm:px-5 lg:px-8 py-4 sm:py-6">
      <div className="mx-auto max-w-4xl space-y-2.5">

        {/* Top nav */}
        <TabNav active="org" />

        {/* Header card */}
        <div className="card px-4 py-3 sm:px-5 sm:py-4">
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
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className={tokenConfigured ? "pill-ok" : "pill-stop"}>
                  <Dot className={tokenConfigured ? "bg-ok" : "bg-danger"} />
                  {tokenConfigured ? "Token configurado" : "Sem token"}
                </span>
                <span className={snap.running ? "pill-run" : "pill-stop"}>
                  <Dot className={snap.running ? "bg-emerald-400" : "bg-danger"} />
                  {snap.running ? "Rodando" : "Parado"}
                </span>
              </div>
            </div>
          </div>

          {/* Instance sub-tabs */}
          {instances.length > 1 && (
            <div className="mt-3 pt-3 border-t border-white/[0.05] flex flex-wrap gap-1.5">
              {instances.map(inst => (
                <button
                  key={inst.id}
                  onClick={() => setActiveId(inst.id)}
                  className={[
                    "px-4 py-1.5 rounded-lg text-xs font-semibold transition-all",
                    inst.id === activeId ? "tab-active" : "tab-inactive card",
                  ].join(" ")}
                >
                  {inst.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Top stats row */}
        <div className="grid grid-cols-3 gap-2.5">
          {/* Control */}
          <div className="col-span-1 card px-4 py-4 flex flex-col items-center justify-center gap-3 min-h-[160px]">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest self-start">
              ⏻ Controle · Bot Org
            </p>
            <button
              onClick={toggleEngine}
              disabled={!snap.running && pendingCount === 0}
              className={[
                "w-20 h-20 rounded-full border-2 flex items-center justify-center transition-all",
                snap.running
                  ? "border-red-500 text-red-400 hover:bg-red-500/10"
                  : canStart
                    ? "border-white/60 text-white hover:bg-white/10"
                    : "border-white/20 text-white/30 cursor-not-allowed",
              ].join(" ")}
            >
              {snap.running
                ? <StopIcon className="w-7 h-7" />
                : <PlayIcon className="w-7 h-7 ml-1" />}
            </button>
            <p className="text-[11px] text-slate-500 text-center leading-snug">
              {snap.running
                ? snap.currentItem
                  ? `Processando: discord.gg/${snap.currentItem.invite_code}`
                  : "Aguardando próximo item…"
                : pendingCount > 0
                  ? `${pendingCount} servidor(es) na fila`
                  : "Adicione servidores pendentes"}
            </p>
          </div>

          {/* Entradas */}
          <div className="card px-4 py-4 flex flex-col justify-center gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-widest">
              <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> Entradas
            </div>
            <p className="text-4xl font-black text-emerald-400 mt-1">{snap.counter}</p>
            <p className="text-[11px] text-slate-500">servidores entrados</p>
          </div>

          {/* Uptime */}
          <div className="card px-4 py-4 flex flex-col justify-center gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-widest">
              <ClockIcon className="w-3.5 h-3.5 text-amber-400" /> Uptime
            </div>
            <p className={`text-3xl font-black font-mono mt-1 ${snap.running ? "text-amber-400" : "text-slate-600"}`}>
              {snap.running ? formatUptime(snap.uptimeMs) : "00:00:00"}
            </p>
            <p className="text-[11px] text-slate-500">{snap.running ? "em execução" : "sem falhas"}</p>
          </div>
        </div>

        {/* Config + Add */}
        <div className="grid sm:grid-cols-2 gap-2.5">
          {/* Config */}
          <div className="card px-5 py-4 space-y-4">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <GearIcon className="w-3.5 h-3.5" /> Configuração
            </h2>

            <div className="space-y-1.5">
              <label className="text-[11px] text-slate-400 uppercase tracking-wide">
                Token Discord
                {tokenConfigured && <span className="ml-2 text-emerald-400 normal-case">✓ configurado</span>}
              </label>
              <div className="relative">
                <input
                  type={showToken ? "text" : "password"}
                  value={tokenDraft}
                  onChange={e => setTokenDraft(e.target.value)}
                  placeholder="Deixe em branco para manter o atual"
                  className="input w-full pr-9 text-[13px]"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-[11px]"
                >
                  {showToken ? "🙈" : "👁"}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-slate-400 uppercase tracking-wide">Chave NopeCHA</label>
              <input
                type="text"
                value={nopechaDraft}
                onChange={e => setNopechaDraft(e.target.value)}
                placeholder="Opcional — para resolver HCaptcha"
                className="input w-full text-[13px]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-slate-400 uppercase tracking-wide">Delay entre entradas (anti-ban)</label>
              <div className="flex items-center gap-2">
                <div className="flex-1 space-y-0.5">
                  <p className="text-[10px] text-slate-500">Mínimo (min)</p>
                  <input type="number" min="1" value={delayMinDraft} onChange={e => setDelayMinDraft(e.target.value)} className="input w-full" />
                </div>
                <span className="text-slate-600 mt-4">—</span>
                <div className="flex-1 space-y-0.5">
                  <p className="text-[10px] text-slate-500">Máximo (min)</p>
                  <input type="number" min="1" value={delayMaxDraft} onChange={e => setDelayMaxDraft(e.target.value)} className="input w-full" />
                </div>
              </div>
              <p className="text-[10px] text-slate-600">Padrão: 5–12 min. Maior = menos ban.</p>
            </div>

            <button onClick={saveCfg} disabled={saving} className="btn-primary w-full text-sm py-2">
              {saving ? "Salvando…" : "💾 Salvar Config"}
            </button>

            {feedback && (
              <p className="text-[12px] text-emerald-400 text-center animate-pulse">{feedback}</p>
            )}
          </div>

          {/* Add invite */}
          <div className="card px-5 py-4 space-y-4">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <PlusIcon className="w-3.5 h-3.5" /> Adicionar Servidor
            </h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={inviteInput}
                onChange={e => setInviteInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addInvite(); }}
                placeholder="discord.gg/codigo ou https://discord.gg/codigo"
                className="input flex-1 text-[13px]"
              />
              <button
                onClick={addInvite}
                disabled={addingInvite || !inviteInput.trim()}
                className="btn-primary px-4 py-2 text-sm shrink-0"
              >
                {addingInvite ? "…" : "+ Add"}
              </button>
            </div>
            <p className="text-[11px] text-slate-600">
              Adicione um link de convite Discord por vez. O Bot Org vai entrar automaticamente com o delay configurado.
            </p>
          </div>
        </div>

        {/* Catálogo de Servidores */}
        <div className="card px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <ListIcon className="w-3.5 h-3.5" /> Catálogo de Servidores ({queue.length})
            </h2>
            {hasFailed && (
              <button
                onClick={retryFailed}
                disabled={retrying}
                className="text-[11px] text-amber-400 hover:text-amber-300 transition-colors flex items-center gap-1"
              >
                <RetryIcon className="w-3 h-3" />
                {retrying ? "Reagendando…" : "Retentar Falhas"}
              </button>
            )}
          </div>

          {queue.length === 0 ? (
            <p className="text-[13px] text-slate-600 py-4 text-center">Nenhum servidor na fila ainda.</p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {queue.map(item => (
                <QueueRow key={item.id} item={item} onRemove={() => removeItem(item.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Logs */}
        <div className="card px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <TerminalIcon className="w-3.5 h-3.5" /> Logs · Bot Org ({logs.length})
            </h2>
            <button
              onClick={clearLogs}
              className="text-[11px] text-slate-500 hover:text-rose-400 transition-colors flex items-center gap-1"
            >
              🗑 Limpar
            </button>
          </div>
          <div className="bg-[#0a0c12] rounded-lg p-3 h-48 overflow-y-auto font-mono text-[11px] space-y-0.5">
            {logs.length === 0 ? (
              <p className="text-slate-600">Nenhum log ainda. Inicie o Bot Org para ver a atividade.</p>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-slate-600 shrink-0">{new Date(log.ts).toLocaleTimeString("pt-BR")}</span>
                  <span className={
                    log.msg.startsWith("✓") ? "text-emerald-400" :
                    log.msg.startsWith("✗") ? "text-red-400" :
                    log.msg.startsWith("Rate limit") ? "text-amber-400" :
                    "text-slate-300"
                  }>{log.msg}</span>
                </div>
              ))
            )}
            <div ref={logsBottomRef} />
          </div>
        </div>

        <p className="text-center text-[11px] text-slate-600 pb-6 pt-1">
          Use por sua conta e risco · Selfbots violam os Termos de Serviço do Discord.
        </p>
      </div>
    </div>
  );
}

function QueueRow({ item, onRemove }: { item: OrgQueueItem; onRemove: () => void }) {
  const statusInfo: Record<string, { icon: string; color: string; label: string }> = {
    pending:    { icon: "⏳", color: "text-amber-400",  label: "Pendente" },
    processing: { icon: "⚙️", color: "text-blue-400",   label: "Processando" },
    done:       { icon: "✅", color: "text-emerald-400", label: "Entrou" },
    failed:     { icon: "❌", color: "text-red-400",     label: "Falhou" },
  };
  const s = statusInfo[item.status] ?? statusInfo.failed!;

  return (
    <div className={[
      "flex items-center gap-3 px-3 py-2 rounded-lg text-[12px]",
      item.status === "processing" ? "bg-blue-500/10" : "bg-white/[0.03]",
    ].join(" ")}>
      <span className={`${s.color} shrink-0 text-base`}>{s.icon}</span>
      <div className="flex-1 min-w-0">
        <p className="font-mono text-slate-300 truncate">
          discord.gg/{item.invite_code}
          {item.result_guild_name && (
            <span className="ml-2 text-emerald-400 font-sans font-semibold">— {item.result_guild_name}</span>
          )}
        </p>
        {item.error_reason && (
          <p className="text-red-400 text-[11px] truncate">HTTP {item.error_reason}</p>
        )}
      </div>
      <span className={`${s.color} text-[10px] font-semibold uppercase shrink-0`}>{s.label}</span>
      {item.status === "pending" && (
        <button onClick={onRemove} className="text-slate-600 hover:text-red-400 transition-colors shrink-0" title="Remover">
          🗑
        </button>
      )}
    </div>
  );
}

/* ── Icons ── */
function EmpireLogo() {
  return (
    <div className="shrink-0 w-9 h-9 sm:w-10 sm:h-10">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <defs>
          <linearGradient id="shieldGradOrg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fbbf24" /><stop offset="50%" stopColor="#f59e0b" /><stop offset="100%" stopColor="#d97706" />
          </linearGradient>
          <linearGradient id="shieldGlossOrg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.2" /><stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M24 3L6 10v14c0 9.5 7.5 18.4 18 21 10.5-2.6 18-11.5 18-21V10L24 3z" fill="url(#shieldGradOrg)" />
        <path d="M24 3L6 10v14c0 1 .05 2 .15 3L24 10.5 41.85 27c.1-1 .15-2 .15-3V10L24 3z" fill="url(#shieldGlossOrg)" />
        <text x="24" y="31" textAnchor="middle" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="22" fill="#1a0a00" letterSpacing="-1">E</text>
      </svg>
    </div>
  );
}
function Dot({ className = "" }: { className?: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${className}`} />;
}
function PlayIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
}
function StopIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>;
}
function CheckIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>;
}
function ClockIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><polyline points="12 6 12 12 16 14" /></svg>;
}
function GearIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
}
function PlusIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}
function ListIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>;
}
function TerminalIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>;
}
function RetryIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-4.95" /></svg>;
}
