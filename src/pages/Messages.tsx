import { useEffect, useState, useCallback, useRef } from "react";
import { TabNav } from "@/components/TabNav";

interface Instance { id: number; name: string; }
interface DmConfig {
  enabled: boolean;
  min_delay_msg: number; max_delay_msg: number;
  min_delay_user: number; max_delay_user: number;
}
interface DmMessage { id: number; position: number; name: string; body: string; }
interface TokenInfo { id: number; position: number; value_preview: string; status: string; username: string | null; }
interface QueueSnapshot {
  enabled: boolean;
  processing: { userId: string; username: string; msgIndex: number; totalMsgs: number } | null;
  waiting: { userId: string; username: string; position: number; addedAt: number }[];
  respondedToday: number;
  respondedTotal: number;
}

const DEFAULT_CFG: DmConfig = { enabled: false, min_delay_msg: 1.5, max_delay_msg: 2.5, min_delay_user: 10, max_delay_user: 15 };
const DEFAULT_SNAP: QueueSnapshot = { enabled: false, processing: null, waiting: [], respondedToday: 0, respondedTotal: 0 };

export default function Messages() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [cfg, setCfg] = useState<DmConfig>(DEFAULT_CFG);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(DEFAULT_SNAP);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editBody, setEditBody] = useState("");
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBody, setNewBody] = useState("");
  const [clearingResponded, setClearingResponded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [debugData, setDebugData] = useState<unknown>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const snapTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeIdRef = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/instances")
      .then((r) => r.json())
      .then((data: Instance[]) => {
        setInstances(data);
        if (data.length > 0) setActiveId(data[0]!.id);
      });
  }, []);

  const load = useCallback(async (id: number) => {
    const [cfgRes, msgsRes, tokRes] = await Promise.all([
      fetch(`/api/messages/config/${id}`).then((r) => r.json()),
      fetch(`/api/messages/${id}`).then((r) => r.json()),
      fetch(`/api/config/${id}`).then((r) => r.json()),
    ]);
    setCfg(cfgRes);
    setMessages(msgsRes);
    setTokens(tokRes.tokens ?? []);
  }, []);

  const pollSnapshot = useCallback(async (id: number) => {
    const snap: QueueSnapshot = await fetch(`/api/messages/${id}/queue/snapshot`).then((r) => r.json());
    setSnapshot(snap);
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (activeId === null) return;
    load(activeId);
    pollSnapshot(activeId);

    if (snapTimerRef.current) clearInterval(snapTimerRef.current);
    snapTimerRef.current = setInterval(() => {
      if (activeIdRef.current !== null) pollSnapshot(activeIdRef.current);
    }, 4_000);

    return () => {
      if (snapTimerRef.current) clearInterval(snapTimerRef.current);
    };
  }, [activeId, load, pollSnapshot]);

  function flash(msg: string) {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2500);
  }

  async function debugRequests() {
    if (activeId === null || debugLoading) return;
    setDebugLoading(true);
    try {
      const data = await fetch(`/api/messages/${activeId}/debug/requests`).then(r => r.json());
      setDebugData(data);
    } finally {
      setDebugLoading(false);
    }
  }

  async function scanNow() {
    if (activeId === null || scanning) return;
    setScanning(true);
    try {
      await fetch(`/api/messages/${activeId}/scan-now`, { method: "POST" });
      await pollSnapshot(activeId);
      flash("Varredura concluída");
    } catch {
      flash("Erro na varredura");
    } finally {
      setScanning(false);
    }
  }

  async function saveCfg(patch: Partial<DmConfig>) {
    if (activeId === null) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true);
    await fetch(`/api/messages/config/${activeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    setSaving(false);
    flash("Configuração salva");
    pollSnapshot(activeId);
  }

  async function addMessage() {
    if (!newName.trim() || !newBody.trim() || activeId === null) return;
    const res = await fetch(`/api/messages/${activeId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), body: newBody.trim() }),
    });
    const created = await res.json();
    setMessages((prev) => [...prev, created]);
    setNewName(""); setNewBody(""); setAddingNew(false);
    flash("Mensagem adicionada");
  }

  async function saveEdit(id: number) {
    if (activeId === null) return;
    await fetch(`/api/messages/${activeId}/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: editName, body: editBody }),
    });
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, name: editName, body: editBody } : m)));
    setEditingId(null);
    flash("Mensagem salva");
  }

  async function deleteMessage(id: number) {
    if (activeId === null) return;
    await fetch(`/api/messages/${activeId}/${id}`, { method: "DELETE" });
    setMessages((prev) => prev.filter((m) => m.id !== id));
    flash("Mensagem removida");
  }

  async function moveMessage(id: number, dir: -1 | 1) {
    if (activeId === null) return;
    const idx = messages.findIndex((m) => m.id === id);
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= messages.length) return;
    const next = [...messages];
    [next[idx], next[targetIdx]] = [next[targetIdx]!, next[idx]!];
    const updated = next.map((m, i) => ({ ...m, position: i }));
    setMessages(updated);
    await Promise.all(updated.map((m) =>
      fetch(`/api/messages/${activeId}/${m.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: m.position }),
      })
    ));
  }

  async function clearResponded() {
    if (activeId === null) return;
    setClearingResponded(true);
    await fetch(`/api/messages/${activeId}/responded/clear`, { method: "DELETE" });
    setClearingResponded(false);
    setConfirmClear(false);
    pollSnapshot(activeId);
    flash("Histórico limpo");
  }

  const connectedTokens = tokens.filter((t) => t.status === "connected");

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">

        {/* Main mode tabs */}
        <TabNav active="dm" />

        {/* Header */}
        <div className="card p-5">
          <div className="flex items-center gap-4">
            <EmpireLogo />
            <div className="flex-1">
              <div className="flex items-baseline gap-3 flex-wrap">
                <h1 className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 bg-clip-text text-transparent">EMPIRE</h1>
                <span className="text-[11px] uppercase tracking-[0.3em] text-slate-400">DM Responder</span>
                <div className="ml-auto flex gap-2">
                  <a href="/" className="text-[11px] uppercase tracking-widest text-slate-400 hover:text-slate-300 transition-colors border border-white/10 hover:border-white/20 rounded-lg px-3 py-1">← Painel</a>
                  <a href="/stats" className="text-[11px] uppercase tracking-widest text-violet-400 hover:text-violet-300 transition-colors border border-violet-500/30 hover:border-violet-400/50 rounded-lg px-3 py-1">📊 Statistics</a>
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-1">Responde automaticamente aos message requests recebidos no Discord</p>
            </div>
          </div>
        </div>

        {/* Instance tabs */}
        <div className="flex gap-2">
          {instances.map((inst) => (
            <button key={inst.id} onClick={() => setActiveId(inst.id)}
              className={`px-5 py-2 rounded-xl text-sm font-bold transition-all ${activeId === inst.id ? "bg-accent text-white shadow-lg shadow-accent/30" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}>
              {inst.name}
            </button>
          ))}
        </div>

        {activeId !== null && (
          <>
            {/* Queue panel */}
            <div className="card p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-[11px] uppercase tracking-widest text-slate-500">Fila de Respostas</p>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-slate-400">Hoje: <b className="text-white">{snapshot.respondedToday}</b></span>
                  <span className="text-slate-400">Total: <b className="text-white">{snapshot.respondedTotal}</b></span>
                  <button
                    onClick={scanNow}
                    disabled={scanning}
                    className="px-2.5 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50 text-[11px] font-medium"
                  >
                    {scanning ? "Varrendo…" : "⟳ Varrer Agora"}
                  </button>
                  <button
                    onClick={debugRequests}
                    disabled={debugLoading}
                    className="px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/25 text-amber-400 hover:bg-amber-500/25 transition-colors disabled:opacity-50 text-[11px] font-medium"
                  >
                    {debugLoading ? "…" : "Debug"}
                  </button>
                </div>
              </div>

              {/* Currently processing */}
              {snapshot.processing ? (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">
                      Enviando para <span className="text-blue-300">{snapshot.processing.username}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Mensagem {snapshot.processing.msgIndex + 1} de {snapshot.processing.totalMsgs}
                      <span className="ml-2 text-slate-600">{snapshot.processing.userId}</span>
                    </p>
                  </div>
                  <MsgIcon className="w-4 h-4 text-blue-400 shrink-0" />
                </div>
              ) : snapshot.enabled && snapshot.waiting.length === 0 ? (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  <p className="text-sm text-slate-400">Monitorando — nenhum request pendente</p>
                </div>
              ) : !snapshot.enabled ? (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
                  <span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" />
                  <p className="text-sm text-slate-500">Responder desativado</p>
                </div>
              ) : null}

              {/* Waiting queue */}
              {snapshot.waiting.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-slate-600">
                    Na fila ({snapshot.waiting.length})
                  </p>
                  {snapshot.waiting.map((u) => (
                    <div key={u.userId} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/5 border border-white/5">
                      <span className="text-xs font-mono text-slate-600 w-4 text-right shrink-0">#{u.position}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-200 font-medium truncate">{u.username}</p>
                        <p className="text-[11px] text-slate-600 font-mono">{u.userId}</p>
                      </div>
                      <span className="text-[10px] text-slate-600 shrink-0">
                        {formatAge(u.addedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Token status */}
            <div className="card p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Tokens Conectados</p>
              {connectedTokens.length === 0 ? (
                <p className="text-sm text-slate-500 italic">Nenhum token conectado nesta instância.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {connectedTokens.map((t) => (
                    <span key={t.id} className="pill bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block mr-1" />
                      {t.username ?? t.value_preview}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Enable toggle */}
            <div className="card p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">Ativar DM Responder</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Quando ativado, o bot monitora message requests a cada ~60s e responde automaticamente.
                  </p>
                </div>
                <button
                  onClick={() => saveCfg({ enabled: !cfg.enabled })}
                  className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${cfg.enabled ? "bg-emerald-500" : "bg-white/10"}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${cfg.enabled ? "translate-x-6" : "translate-x-0"}`} />
                </button>
              </div>
              {cfg.enabled && (
                <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs text-emerald-300">Responder ativo — próxima varredura em ~60s</span>
                </div>
              )}
            </div>

            {/* Delay settings */}
            <div className="card p-5 space-y-5">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">Configuração de Delays</p>
              <div>
                <label className="text-sm font-semibold text-white block mb-1">Delay entre mensagens (segundos)</label>
                <p className="text-xs text-slate-500 mb-3">Intervalo aleatório entre cada mensagem enviada para o mesmo usuário.</p>
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase text-slate-500 tracking-widest">Mínimo</span>
                    <input className="input w-24 text-center" type="number" min={0.5} max={60} step={0.5} value={cfg.min_delay_msg}
                      onChange={(e) => setCfg((c) => ({ ...c, min_delay_msg: Number(e.target.value) }))}
                      onBlur={() => saveCfg({})} />
                  </div>
                  <span className="text-slate-500 text-lg mt-4">—</span>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase text-slate-500 tracking-widest">Máximo</span>
                    <input className="input w-24 text-center" type="number" min={0.5} max={60} step={0.5} value={cfg.max_delay_msg}
                      onChange={(e) => setCfg((c) => ({ ...c, max_delay_msg: Number(e.target.value) }))}
                      onBlur={() => saveCfg({})} />
                  </div>
                  <span className="text-slate-400 text-sm mt-4">seg</span>
                </div>
              </div>
              <div className="border-t border-white/5 pt-5">
                <label className="text-sm font-semibold text-white block mb-1">Delay entre usuários (segundos)</label>
                <p className="text-xs text-slate-500 mb-3">
                  Intervalo aleatório aguardado após a <b className="text-white/50">última mensagem</b> ser enviada, antes de responder o próximo usuário da fila.
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase text-slate-500 tracking-widest">Mínimo</span>
                    <input className="input w-24 text-center" type="number" min={1} max={300} step={1} value={cfg.min_delay_user}
                      onChange={(e) => setCfg((c) => ({ ...c, min_delay_user: Number(e.target.value) }))}
                      onBlur={() => saveCfg({})} />
                  </div>
                  <span className="text-slate-500 text-lg mt-4">—</span>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase text-slate-500 tracking-widest">Máximo</span>
                    <input className="input w-24 text-center" type="number" min={1} max={300} step={1} value={cfg.max_delay_user}
                      onChange={(e) => setCfg((c) => ({ ...c, max_delay_user: Number(e.target.value) }))}
                      onBlur={() => saveCfg({})} />
                  </div>
                  <span className="text-slate-400 text-sm mt-4">seg</span>
                </div>
              </div>
            </div>

            {/* Message list */}
            <div className="card p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-widest text-slate-500">Mensagens</p>
                  <p className="text-xs text-slate-500 mt-0.5">Enviadas em ordem de cima pra baixo. Use as setas para reordenar.</p>
                </div>
                <button onClick={() => { setAddingNew(true); setNewName(""); setNewBody(""); }}
                  className="btn-primary text-sm px-4 py-2">
                  + Adicionar
                </button>
              </div>

              {messages.length === 0 && !addingNew && (
                <div className="text-center py-8 text-slate-500 text-sm italic border border-dashed border-white/10 rounded-xl">
                  Nenhuma mensagem configurada. Clique em "+ Adicionar" para começar.
                </div>
              )}

              <div className="space-y-3">
                {messages.map((msg, idx) => (
                  <div key={msg.id} className="bg-white/5 rounded-xl border border-white/10 p-4">
                    {editingId === msg.id ? (
                      <div className="space-y-3">
                        <div>
                          <label className="text-[10px] uppercase text-slate-500 tracking-widest block mb-1">Nome (referência)</label>
                          <input className="input w-full text-sm" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="ex: Apresentação" />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase text-slate-500 tracking-widest block mb-1">Corpo da mensagem</label>
                          <textarea className="input w-full text-sm resize-none h-24 font-mono" value={editBody} onChange={(e) => setEditBody(e.target.value)} placeholder="Texto que será enviado..." />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => saveEdit(msg.id)} className="btn-primary text-sm px-4 py-1.5">Salvar</button>
                          <button onClick={() => setEditingId(null)} className="bg-white/10 hover:bg-white/15 text-slate-300 text-sm px-4 py-1.5 rounded-lg transition-colors">Cancelar</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-3">
                        <div className="flex flex-col gap-1 shrink-0">
                          <button onClick={() => moveMessage(msg.id, -1)} disabled={idx === 0}
                            className="w-6 h-6 flex items-center justify-center rounded bg-white/5 hover:bg-white/15 disabled:opacity-20 disabled:cursor-not-allowed transition-colors" title="Mover para cima">
                            <UpIcon />
                          </button>
                          <button onClick={() => moveMessage(msg.id, 1)} disabled={idx === messages.length - 1}
                            className="w-6 h-6 flex items-center justify-center rounded bg-white/5 hover:bg-white/15 disabled:opacity-20 disabled:cursor-not-allowed transition-colors" title="Mover para baixo">
                            <DownIcon />
                          </button>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-accent/70">#{idx + 1}</span>
                            <span className="text-sm font-semibold text-white truncate">{msg.name}</span>
                          </div>
                          <p className="text-sm text-slate-300 whitespace-pre-wrap break-words leading-relaxed font-mono bg-black/20 rounded-lg px-3 py-2">
                            {msg.body}
                          </p>
                        </div>
                        <div className="flex flex-col gap-1 shrink-0">
                          <button onClick={() => { setEditingId(msg.id); setEditName(msg.name); setEditBody(msg.body); }}
                            className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/15 text-slate-400 hover:text-white transition-colors" title="Editar">
                            <EditIcon />
                          </button>
                          <button onClick={() => deleteMessage(msg.id)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors" title="Remover">
                            <TrashIcon />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {addingNew && (
                  <div className="bg-white/5 rounded-xl border border-accent/20 p-4 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-accent/70">Nova mensagem</p>
                    <div>
                      <label className="text-[10px] uppercase text-slate-500 tracking-widest block mb-1">Nome (apenas para sua referência)</label>
                      <input className="input w-full text-sm" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ex: Saudação" autoFocus />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase text-slate-500 tracking-widest block mb-1">Corpo da mensagem</label>
                      <textarea className="input w-full text-sm resize-none h-24 font-mono" value={newBody} onChange={(e) => setNewBody(e.target.value)} placeholder="Texto que será enviado no Discord..." />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={addMessage} disabled={!newName.trim() || !newBody.trim()} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-40">Adicionar</button>
                      <button onClick={() => setAddingNew(false)} className="bg-white/10 hover:bg-white/15 text-slate-300 text-sm px-4 py-1.5 rounded-lg transition-colors">Cancelar</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Danger zone */}
            <div className="card p-5">
              <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Zona de risco</p>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-white">Limpar histórico de respondidos</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Zera a lista de usuários já respondidos ({snapshot.respondedTotal} registros). O bot poderá responder novamente para todos eles.
                  </p>
                </div>
                {confirmClear ? (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={clearResponded} disabled={clearingResponded}
                      className="bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-xl font-bold transition-colors disabled:opacity-50">
                      {clearingResponded ? "Limpando…" : "Confirmar"}
                    </button>
                    <button onClick={() => setConfirmClear(false)} className="bg-white/10 hover:bg-white/15 text-slate-300 text-sm px-3 py-2 rounded-xl transition-colors">Cancelar</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmClear(true)}
                    className="bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 text-sm px-4 py-2 rounded-xl border border-red-500/20 transition-colors shrink-0">
                    Limpar histórico
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {saving && (
          <div className="fixed bottom-6 right-6 bg-slate-800 border border-white/10 rounded-xl px-4 py-2 text-sm text-slate-300 shadow-xl">Salvando…</div>
        )}
        {feedback && !saving && (
          <div className="fixed bottom-6 right-6 bg-slate-800 border border-emerald-500/30 rounded-xl px-4 py-2 text-sm text-emerald-300 shadow-xl">✓ {feedback}</div>
        )}

        {/* Modal de Debug */}
        {debugData !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
            <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                <p className="text-sm font-semibold text-white">Debug — Resposta Raw do Discord</p>
                <button onClick={() => setDebugData(null)} className="text-slate-400 hover:text-white text-lg leading-none">✕</button>
              </div>
              <div className="overflow-auto p-4 flex-1">
                <pre className="text-[11px] text-slate-300 whitespace-pre-wrap break-all font-mono">
                  {JSON.stringify(debugData, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatAge(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m atrás`;
  return `${Math.floor(diff / 3600)}h atrás`;
}

function EmpireLogo() {
  return (
    <div className="relative shrink-0 w-10 h-10">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-lg">
        <defs><linearGradient id="sg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#fbbf24" /><stop offset="100%" stopColor="#d97706" /></linearGradient></defs>
        <path d="M24 3L6 10v14c0 9.5 7.5 18.4 18 21 10.5-2.6 18-11.5 18-21V10L24 3z" fill="url(#sg2)" />
        <text x="24" y="31" textAnchor="middle" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="22" fill="#1a0a00" letterSpacing="-1">E</text>
      </svg>
    </div>
  );
}

function UpIcon() { return <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor"><path d="M8 4l-5 5h10z"/></svg>; }
function DownIcon() { return <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor"><path d="M8 12l5-5H3z"/></svg>; }
function EditIcon() { return <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="currentColor"><path d="M13.586 2.586a2 2 0 012.828 2.828l-9 9A2 2 0 016 15H4v-2a2 2 0 01.586-1.414l9-9z"/></svg>; }
function TrashIcon() { return <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zm-1 5a1 1 0 012 0v6a1 1 0 11-2 0V7zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V7z" clipRule="evenodd"/></svg>; }
function MsgIcon({ className = "" }) { return <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H6l-4 4V5z"/></svg>; }
