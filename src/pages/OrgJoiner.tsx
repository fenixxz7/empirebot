import { useCallback, useEffect, useRef, useState } from "react";

interface Instance { id: number; name: string; }

interface TokenPoolEntry {
  id: number;
  label: string | null;
  value_preview: string;
  status: string;
  username: string | null;
  value_full?: string;
}

interface OrgConfig {
  nopecha_key: string | null;
  delay_min_ms: number;
  delay_max_ms: number;
  enabled: boolean;
  token_pool: TokenPoolEntry[];
  selected_token_id: number | null;
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
  nopecha_key: null, delay_min_ms: 300000, delay_max_ms: 720000,
  enabled: false, token_pool: [], selected_token_id: null,
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

export default function OrgJoiner({ isAdmin = false }: { isAdmin?: boolean }) {
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
  const [retrying, setRetrying] = useState(false);

  /* ── Token pool states ─────────────────────────────────────── */
  const [tokensMode, setTokensMode] = useState<"normal" | "add" | "delete">("normal");
  const [selectedTokenId, setSelectedTokenId] = useState<number | null>(null);
  const [newTokenValue, setNewTokenValue] = useState("");
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [addingToken, setAddingToken] = useState(false);
  const [removingToken, setRemovingToken] = useState(false);
  const [revealedTokenIds, setRevealedTokenIds] = useState<Set<number>>(new Set());
  const [tokenFullValues, setTokenFullValues] = useState<Record<number, string>>({});

  /* ── Config form states ────────────────────────────────────── */
  const [nopechaDraft, setNopechaDraft] = useState("");
  const [delayMinDraft, setDelayMinDraft] = useState("5");
  const [delayMaxDraft, setDelayMaxDraft] = useState("12");

  const snapTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const logsBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/instances")
      .then(r => r.json())
      .then((data: Instance[]) => {
        // BOT3 nunca aparece no Bot Org; BOT X (BOT2) só aparece para admin
        const visible = data
          .filter(i => i.name !== "BOT3")
          .filter(i => isAdmin || i.name !== "BOT2");
        setInstances(visible);
        if (visible.length > 0) setActiveId(visible[0]!.id);
      });
  }, [isAdmin]);

  const loadAll = useCallback(async (id: number) => {
    const [cfgRes, snapRes, queueRes, logsRes] = await Promise.all([
      fetch(`/api/org-joiner/config/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/snapshot/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/queue/${id}`).then(r => r.json()),
      fetch(`/api/org-joiner/logs/${id}`).then(r => r.json()),
    ]);
    setCfg(cfgRes);
    setSelectedTokenId(cfgRes.selected_token_id ?? null);
    setNopechaDraft(cfgRes.nopecha_key ?? "");
    setDelayMinDraft(String(Math.round((cfgRes.delay_min_ms ?? 300000) / 60000)));
    setDelayMaxDraft(String(Math.round((cfgRes.delay_max_ms ?? 720000) / 60000)));
    setSnap(snapRes);
    setQueue(Array.isArray(queueRes) ? queueRes : []);
    setLogs(Array.isArray(logsRes) ? logsRes : []);
    setTokensMode("normal");
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
    await fetch(`/api/org-joiner/config/${activeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nopecha_key: nopechaDraft.trim() || null,
        delay_min_ms: Math.round(Number(delayMinDraft) * 60000),
        delay_max_ms: Math.round(Number(delayMaxDraft) * 60000),
        enabled: cfg.enabled,
      }),
    });
    setSaving(false);
    flash("Configuração salva!");
  }

  async function addToken() {
    if (!newTokenValue.trim() || activeId === null || addingToken) return;
    setAddingToken(true);
    const res = await fetch(`/api/org-joiner/tokens/${activeId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: newTokenValue.trim(), label: newTokenLabel.trim() || undefined }),
    });
    const data = await res.json();
    if (data.ok) {
      setNewTokenValue("");
      setNewTokenLabel("");
      setTokensMode("normal");
      await loadAll(activeId);
      flash("Token adicionado e selecionado!");
    } else {
      flash(`Erro: ${data.error}`);
    }
    setAddingToken(false);
  }

  async function selectToken(tokenPoolId: number) {
    if (activeId === null) return;
    await fetch(`/api/org-joiner/tokens/${activeId}/select`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token_pool_id: tokenPoolId }),
    });
    setSelectedTokenId(tokenPoolId);
  }

  async function deselectToken() {
    if (activeId === null) return;
    await fetch(`/api/org-joiner/tokens/${activeId}/deselect`, { method: "DELETE" });
    setSelectedTokenId(null);
  }

  async function removeToken() {
    if (activeId === null || removingToken || selectedTokenId === null) return;
    setRemovingToken(true);
    await fetch(`/api/org-joiner/tokens/${activeId}/pool/${selectedTokenId}`, { method: "DELETE" });
    setSelectedTokenId(null);
    setRevealedTokenIds(new Set());
    setTokenFullValues({});
    setTokensMode("normal");
    await loadAll(activeId);
    flash("Token removido do pool.");
    setRemovingToken(false);
  }

  async function toggleReveal(tokenId: number) {
    if (!isAdmin || activeId === null) return;
    if (revealedTokenIds.has(tokenId)) {
      setRevealedTokenIds(prev => { const s = new Set(prev); s.delete(tokenId); return s; });
      return;
    }
    if (tokenFullValues[tokenId]) {
      setRevealedTokenIds(prev => new Set([...prev, tokenId]));
      return;
    }
    const res = await fetch(`/api/org-joiner/tokens/${activeId}/pool/${tokenId}/reveal`);
    if (res.ok) {
      const data = await res.json();
      setTokenFullValues(prev => ({ ...prev, [tokenId]: data.value }));
      setRevealedTokenIds(prev => new Set([...prev, tokenId]));
    }
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
  const tokenConfigured = selectedTokenId !== null;

  return (
    <>
        {/* Instance + status bar */}
        <div className="card px-4 py-3 sm:px-5 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1.5 flex-1">
            <span className={tokenConfigured ? "pill-ok" : "pill-stop"}>
              <Dot className={tokenConfigured ? "bg-ok" : "bg-danger"} />
              {tokenConfigured ? "Token configurado" : "Sem token"}
            </span>
            <span className={snap.running ? "pill-run" : "pill-stop"}>
              <Dot className={snap.running ? "bg-emerald-400" : "bg-danger"} />
              {snap.running ? "Rodando" : "Parado"}
            </span>
          </div>
          {instances.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {instances.map(inst => (
                <button
                  key={inst.id}
                  onClick={() => setActiveId(inst.id)}
                  className={[
                    "px-4 py-1.5 rounded-lg text-xs font-semibold transition-all",
                    inst.id === activeId ? "tab-active" : "tab-inactive card",
                  ].join(" ")}
                >
                  {inst.name === "BOT2" ? (
                    <span className="flex items-center gap-1">BOT X <LockIcon className="w-2.5 h-2.5 opacity-50" /></span>
                  ) : inst.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Top stats row */}
        <div className="grid grid-cols-3 gap-2.5">
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
              {snap.running ? <StopIcon className="w-7 h-7" /> : <PlayIcon className="w-7 h-7 ml-1" />}
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

          <div className="card px-4 py-4 flex flex-col justify-center gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-widest">
              <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> Entradas
            </div>
            <p className="text-4xl font-black text-emerald-400 mt-1">{snap.counter}</p>
            <p className="text-[11px] text-slate-500">servidores entrados</p>
          </div>

          <div className="card px-4 py-4 flex flex-col justify-center gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-widest">
              <ClockIcon className="w-3.5 h-3.5 text-amber-400" /> Uptime
            </div>
            <p className={`text-3xl font-black font-mono mt-1 ${snap.running ? "text-amber-400" : "text-slate-600"}`}>
              {snap.running ? formatUptime(snap.uptimeMs) : "00:00:00"}
            </p>
            <p className="text-[11px] text-slate-500">{snap.running ? "em execução" : "parado"}</p>
          </div>
        </div>

        {/* Config + Add Invite */}
        <div className="grid sm:grid-cols-2 gap-2.5">
          {/* Config */}
          <div className="card px-5 py-4 space-y-4">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <GearIcon className="w-3.5 h-3.5" /> Configuração
            </h2>

            {/* ── Token pool selector ──────────────────────────── */}
            <div className="space-y-2">
              <label className="text-[11px] text-slate-400 uppercase tracking-wide">
                Selecionar token (até 1)
              </label>

              {/* Token list */}
              <div className="rounded-xl bg-[#0a0c14] border border-white/10 p-2.5 space-y-1 min-h-[48px]">
                {cfg.token_pool.length === 0 ? (
                  <p className="text-[12px] text-slate-500 py-1">Nenhum token cadastrado no pool.</p>
                ) : (
                  cfg.token_pool.map(t => {
                    const isSelected = selectedTokenId === t.id;
                    const isRevealed = revealedTokenIds.has(t.id);
                    return (
                      <div key={t.id} className={[
                        "flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors",
                        tokensMode === "delete" && isSelected ? "bg-rose-500/10 ring-1 ring-rose-400/40" : "hover:bg-white/5",
                      ].join(" ")}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {
                            if (isSelected) deselectToken();
                            else selectToken(t.id);
                          }}
                          className="w-3.5 h-3.5 accent-amber-400 shrink-0"
                        />
                        {t.label && (
                          <span className="text-[12px] text-slate-200 font-medium shrink-0">{t.label}</span>
                        )}
                        <span className="font-mono text-[11px] text-slate-400 flex-1 truncate">
                          {isRevealed && tokenFullValues[t.id] ? tokenFullValues[t.id] : t.value_preview}
                        </span>
                        {t.username && (
                          <span className="text-[11px] text-slate-300 truncate max-w-[120px] shrink-0">{t.username}</span>
                        )}
                        <TokenStatus status={t.status} />
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => toggleReveal(t.id)}
                            title={isRevealed ? "Ocultar token" : "Ver token completo"}
                            className="text-slate-500 hover:text-amber-400 transition-colors shrink-0"
                          >
                            {isRevealed ? <EyeOffIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Action row */}
              {tokensMode === "normal" && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setTokensMode("add")}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.06] text-slate-300 hover:bg-white/[0.10] hover:text-white transition-all ring-1 ring-white/10"
                  >
                    <PlusIcon className="w-3 h-3" /> Adicionar token
                  </button>
                  <button
                    type="button"
                    onClick={removeToken}
                    disabled={selectedTokenId === null || removingToken}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-rose-300 bg-white/[0.04] hover:bg-rose-500/10 ring-1 ring-rose-400/20 hover:ring-rose-400/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <TrashIcon className="w-3 h-3" />
                    {removingToken ? "Removendo…" : "Remover do pool"}
                  </button>
                  <span className="text-[11px] text-slate-500 ml-1">
                    {selectedTokenId !== null ? 1 : 0}/1 selecionado(s)
                  </span>
                </div>
              )}

              {tokensMode === "add" && (
                <div className="rounded-xl border border-amber-400/20 bg-amber-500/5 p-3 space-y-2">
                  <p className="text-[11px] text-slate-400">
                    Cole o token do Discord. O apelido é opcional (só para identificação visual).
                  </p>
                  <input
                    type="password"
                    className="input w-full font-mono text-xs"
                    placeholder="Token (obrigatório)"
                    value={newTokenValue}
                    onChange={e => setNewTokenValue(e.target.value)}
                    autoFocus
                  />
                  <input
                    type="text"
                    className="input w-full text-xs"
                    placeholder="Apelido (opcional)"
                    value={newTokenLabel}
                    onChange={e => setNewTokenLabel(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={addToken}
                      disabled={addingToken || !newTokenValue.trim()}
                      className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50"
                    >
                      {addingToken ? "Adicionando…" : "Confirmar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setTokensMode("normal"); setNewTokenValue(""); setNewTokenLabel(""); }}
                      className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors px-2"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* NopeCHA */}
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

            {/* Delay */}
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
    </>
  );
}

/* ── Token status badge ────────────────────────────────────────────── */
function TokenStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    connected:    { label: "conectado",    cls: "text-emerald-400 bg-emerald-400/10" },
    disconnected: { label: "desconectado", cls: "text-red-400 bg-red-400/10" },
    unknown:      { label: "desconhecido", cls: "text-slate-500 bg-white/5" },
  };
  const s = map[status] ?? map.unknown!;
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${s.cls}`}>
      {s.label}
    </span>
  );
}

/* ── Queue row ─────────────────────────────────────────────────────── */
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
          <p className="text-red-400 text-[11px] truncate">{item.error_reason}</p>
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

/* ── Icons ─────────────────────────────────────────────────────────── */
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
function TrashIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>;
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
function EyeIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function EyeOffIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;
}
function LockIcon({ className = "" }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
}
