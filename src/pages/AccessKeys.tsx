import { useEffect, useState } from "react";

type Instance = { id: number; name: string };

type AccessKey = {
  id: number;
  label: string;
  created_at: string;
  force_logout_at: string | null;
  expires_at: string | null;
  allowed_instance_ids: number[] | null;
  is_permanent: boolean;
};
type LoginEntry = { ip: string; logged_in_at: string };

const EXPIRY_PRESETS = [
  { label: "Sem expiração", value: "" },
  { label: "1 hora", hours: 1 },
  { label: "6 horas", hours: 6 },
  { label: "12 horas", hours: 12 },
  { label: "1 dia", hours: 24 },
  { label: "3 dias", hours: 72 },
  { label: "7 dias", hours: 168 },
  { label: "30 dias", hours: 720 },
  { label: "Personalizado", value: "custom" },
];

function calcExpiresAt(preset: string, customDays: string, customHours: string): string | null {
  if (!preset || preset === "") return null;
  const now = new Date();
  if (preset === "custom") {
    const d = parseInt(customDays || "0", 10);
    const h = parseInt(customHours || "0", 10);
    if (d === 0 && h === 0) return null;
    now.setHours(now.getHours() + h + d * 24);
    return now.toISOString();
  }
  const found = EXPIRY_PRESETS.find(p => ("hours" in p) && p.label === preset);
  if (found && "hours" in found) {
    now.setHours(now.getHours() + found.hours);
    return now.toISOString();
  }
  return null;
}

function formatExpiry(expires_at: string | null): { text: string; expired: boolean } {
  if (!expires_at) return { text: "Sem expiração", expired: false };
  const d = new Date(expires_at);
  const expired = d < new Date();
  return {
    text: (expired ? "Expirou em " : "Expira em ") + d.toLocaleString("pt-BR"),
    expired,
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0f1117",
  border: "1px solid #2a2d3d",
  borderRadius: 8,
  color: "#f0f0f0",
  padding: "10px 14px",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

// ── Edit modal ────────────────────────────────────────────────────────
function EditModal({
  keyItem,
  instances,
  onClose,
  onSaved,
}: {
  keyItem: AccessKey;
  instances: Instance[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [allowedIds, setAllowedIds] = useState<number[]>(keyItem.allowed_instance_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleInstance(id: number) {
    setAllowedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (password.trim()) body.password = password.trim();
      // null = acesso total; array vazio = nenhuma instância; array com itens = restrição
      body.allowed_instance_ids = allowedIds.length > 0 ? allowedIds : null;

      const res = await fetch(`/api/auth/access-keys/${keyItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao salvar.");
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#1a1d27", border: "1px solid #2a2d3d", borderRadius: 14,
        padding: 24, width: "100%", maxWidth: 440,
      }}>
        <h3 style={{ color: "#f0f0f0", margin: "0 0 16px", fontSize: 16 }}>
          ✏️ Editar acesso — <span style={{ color: "#fbbf24" }}>{keyItem.label}</span>
        </h3>

        {/* Nova senha */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Nova senha <span style={{ color: "#6b7280" }}>(deixe em branco para manter)</span>
          </label>
          <input
            style={inputStyle}
            type="text"
            placeholder="Mínimo 4 caracteres"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>

        {/* Instâncias permitidas */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Instâncias permitidas
            <span style={{ color: "#6b7280", marginLeft: 6, textTransform: "none" }}>
              (nenhuma selecionada = acesso total)
            </span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {instances.map(inst => (
              <label key={inst.id} style={{
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                padding: "8px 12px", borderRadius: 8,
                background: allowedIds.includes(inst.id) ? "rgba(99,102,241,0.12)" : "#0f1117",
                border: `1px solid ${allowedIds.includes(inst.id) ? "rgba(99,102,241,0.4)" : "#2a2d3d"}`,
                transition: "all 0.15s",
              }}>
                <input
                  type="checkbox"
                  checked={allowedIds.includes(inst.id)}
                  onChange={() => toggleInstance(inst.id)}
                  style={{ width: 14, height: 14, accentColor: "#6366f1" }}
                />
                <span style={{ color: "#f0f0f0", fontSize: 13 }}>{inst.name}</span>
                <span style={{ color: "#6b7280", fontSize: 11, marginLeft: "auto" }}>#{inst.id}</span>
              </label>
            ))}
          </div>
        </div>

        {err && (
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "8px 12px", color: "#fca5a5", fontSize: 13, marginBottom: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.05)", border: "1px solid #2a2d3d",
              color: "#9ca3af", borderRadius: 8, padding: "9px 18px", fontSize: 13, cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              background: saving ? "#4f46e5aa" : "linear-gradient(135deg, #6366f1, #4f46e5)",
              color: "white", border: "none", borderRadius: 8,
              padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────
export default function AccessKeys() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [expiryPreset, setExpiryPreset] = useState("");
  const [customDays, setCustomDays] = useState("0");
  const [customHours, setCustomHours] = useState("0");
  const [newAllowedIds, setNewAllowedIds] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [logins, setLogins] = useState<Record<number, LoginEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [loadingLogins, setLoadingLogins] = useState<Record<number, boolean>>({});
  const [editKey, setEditKey] = useState<AccessKey | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [keysRes, instRes] = await Promise.all([
        fetch("/api/auth/access-keys"),
        fetch("/api/instances"),
      ]);
      if (!keysRes.ok) throw new Error("Sem permissão");
      setKeys(await keysRes.json());
      if (instRes.ok) {
        const instList: { id: number; name: string }[] = await instRes.json();
        setInstances(instList.map(i => ({ id: i.id, name: i.name })));
      }
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function showFeedback(msg: string, ok: boolean) {
    setFeedback({ msg, ok });
    setTimeout(() => setFeedback(null), 3500);
  }

  function toggleNewInstance(id: number) {
    setNewAllowedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const expires_at = calcExpiresAt(expiryPreset, customDays, customHours);
      const allowed_instance_ids = newAllowedIds.length > 0 ? newAllowedIds : null;
      const res = await fetch("/api/auth/access-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, password, expires_at, allowed_instance_ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao criar acesso.");
      setLabel(""); setPassword(""); setExpiryPreset(""); setCustomDays("0"); setCustomHours("0");
      setNewAllowedIds([]);
      await load();
      showFeedback("Acesso criado com sucesso.", true);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Erro.", false);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number, lbl: string) {
    if (!confirm(`Revogar acesso de "${lbl}"?`)) return;
    try {
      const res = await fetch(`/api/auth/access-keys/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao revogar acesso.");
      await load();
      showFeedback(`Acesso de "${lbl}" revogado.`, true);
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : "Erro ao revogar acesso.", false);
    }
  }

  async function handleForceLogout(id: number, lbl: string) {
    if (!confirm(`Forçar logout de todas as sessões ativas de "${lbl}"?`)) return;
    try {
      const res = await fetch(`/api/auth/access-keys/${id}/force-logout`, { method: "POST" });
      if (!res.ok) throw new Error();
      await load();
      showFeedback(`Sessões de "${lbl}" encerradas.`, true);
    } catch {
      showFeedback("Erro ao forçar logout.", false);
    }
  }

  async function toggleLogins(id: number) {
    const nowExpanded = !expanded[id];
    setExpanded(prev => ({ ...prev, [id]: nowExpanded }));
    if (nowExpanded && !logins[id]) {
      setLoadingLogins(prev => ({ ...prev, [id]: true }));
      try {
        const res = await fetch(`/api/auth/access-keys/${id}/logins`);
        const data: LoginEntry[] = await res.json();
        setLogins(prev => ({ ...prev, [id]: data }));
      } catch {
        setLogins(prev => ({ ...prev, [id]: [] }));
      } finally {
        setLoadingLogins(prev => ({ ...prev, [id]: false }));
      }
    }
  }

  function instanceLabel(id: number): string {
    return instances.find(i => i.id === id)?.name ?? `#${id}`;
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0f1117", padding: "32px 16px", fontFamily: "'Inter', sans-serif" }}>
      <div style={{ maxWidth: 660, margin: "0 auto" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <a href="/" style={{ color: "#6b7280", fontSize: 13, textDecoration: "none" }}>← Voltar</a>
          <h1 style={{ color: "#f0f0f0", fontSize: 20, fontWeight: 700, margin: 0 }}>🔑 Acessos</h1>
          <a href="/auditoria" style={{ marginLeft: "auto", color: "#a78bfa", fontSize: 12, textDecoration: "none", border: "1px solid rgba(167,139,250,0.3)", borderRadius: 7, padding: "4px 10px" }}>
            📋 Auditoria
          </a>
        </div>

        {/* Create form */}
        <div style={{ background: "#1a1d27", border: "1px solid #2a2d3d", borderRadius: 14, padding: 24, marginBottom: 24 }}>
          <p style={{ color: "#9ca3af", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
            Crie senhas extras para liberar acesso ao painel. Cada acesso pode ser revogado individualmente.
          </p>
          <form onSubmit={handleAdd}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>Rótulo (quem é)</label>
                <input style={inputStyle} placeholder="Ex: João" value={label} onChange={e => setLabel(e.target.value)} required />
              </div>
              <div>
                <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>Senha</label>
                <input style={inputStyle} type="text" placeholder="Mínimo 4 caracteres" value={password} onChange={e => setPassword(e.target.value)} required minLength={4} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>Validade do acesso</label>
              <select style={selectStyle} value={expiryPreset} onChange={e => setExpiryPreset(e.target.value)}>
                {EXPIRY_PRESETS.map(p => (
                  <option key={p.label} value={"value" in p ? p.value : p.label}>{p.label}</option>
                ))}
              </select>
            </div>

            {expiryPreset === "custom" && (
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
                <div>
                  <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>Dias</label>
                  <input style={inputStyle} type="number" min="0" value={customDays} onChange={e => setCustomDays(e.target.value)} placeholder="0" />
                </div>
                <div>
                  <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>Horas</label>
                  <input style={inputStyle} type="number" min="0" max="23" value={customHours} onChange={e => setCustomHours(e.target.value)} placeholder="0" />
                </div>
              </div>
            )}

            {/* Instâncias permitidas no create form */}
            {instances.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Instâncias permitidas
                  <span style={{ color: "#6b7280", marginLeft: 6, textTransform: "none" }}>
                    (nenhuma = acesso total)
                  </span>
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {instances.map(inst => (
                    <label key={inst.id} style={{
                      display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                      padding: "5px 10px", borderRadius: 7,
                      background: newAllowedIds.includes(inst.id) ? "rgba(99,102,241,0.12)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${newAllowedIds.includes(inst.id) ? "rgba(99,102,241,0.4)" : "#2a2d3d"}`,
                    }}>
                      <input
                        type="checkbox"
                        checked={newAllowedIds.includes(inst.id)}
                        onChange={() => toggleNewInstance(inst.id)}
                        style={{ accentColor: "#6366f1" }}
                      />
                      <span style={{ color: "#f0f0f0", fontSize: 12 }}>{inst.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={adding}
              style={{
                marginTop: 14,
                background: adding ? "#92400e" : "linear-gradient(135deg, #f59e0b, #d97706)",
                color: "#0f1117", border: "none", borderRadius: 8,
                padding: "10px 22px", fontSize: 13, fontWeight: 700,
                cursor: adding ? "not-allowed" : "pointer", opacity: adding ? 0.7 : 1,
              }}
            >
              {adding ? "Criando…" : "+ Criar acesso"}
            </button>
          </form>

          {feedback && (
            <div style={{
              marginTop: 14, padding: "10px 14px", borderRadius: 8, fontSize: 13,
              background: feedback.ok ? "rgba(52,211,153,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${feedback.ok ? "rgba(52,211,153,0.3)" : "rgba(239,68,68,0.3)"}`,
              color: feedback.ok ? "#6ee7b7" : "#fca5a5",
            }}>
              {feedback.msg}
            </div>
          )}
        </div>

        {/* Keys list */}
        <div style={{ background: "#1a1d27", border: "1px solid #2a2d3d", borderRadius: 14, padding: 24 }}>
          <h2 style={{ color: "#f0f0f0", fontSize: 15, fontWeight: 600, margin: "0 0 16px" }}>
            Acessos ativos ({keys.length})
          </h2>

          {loading && <p style={{ color: "#6b7280", fontSize: 13 }}>Carregando…</p>}
          {!loading && keys.length === 0 && <p style={{ color: "#6b7280", fontSize: 13, margin: 0 }}>Nenhum acesso criado ainda.</p>}

          {!loading && keys.map(k => {
            const expiry = formatExpiry(k.expires_at);
            return (
              <div key={k.id} style={{ borderBottom: "1px solid #2a2d3d", paddingBottom: 14, marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ color: "#f0f0f0", fontSize: 14, fontWeight: 600 }}>{k.label}</span>
                      {k.is_permanent && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 5,
                          background: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.3)",
                          color: "#fb923c", textTransform: "uppercase", letterSpacing: "0.05em",
                        }}>
                          Permanente
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 3 }}>
                      <span style={{ color: "#6b7280", fontSize: 11 }}>
                        Criado em {new Date(k.created_at).toLocaleString("pt-BR")}
                      </span>
                      <span style={{ fontSize: 11, color: expiry.expired ? "#f87171" : k.expires_at ? "#34d399" : "#6b7280" }}>
                        {expiry.expired ? "⛔" : k.expires_at ? "⏱" : "∞"} {expiry.text}
                      </span>
                    </div>

                    {/* Instâncias permitidas */}
                    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {k.allowed_instance_ids && k.allowed_instance_ids.length > 0 ? (
                        k.allowed_instance_ids.map(id => (
                          <span key={id} style={{
                            fontSize: 10, padding: "2px 7px", borderRadius: 5,
                            background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)",
                            color: "#a5b4fc",
                          }}>
                            {instanceLabel(id)}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: 10, color: "#4b5563" }}>Acesso total (todas as instâncias)</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                    <button onClick={() => setEditKey(k)} style={{
                      background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.3)",
                      color: "#a5b4fc", borderRadius: 7, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                    }}>
                      ✏️ Editar
                    </button>

                    <button onClick={() => toggleLogins(k.id)} style={{
                      background: expanded[k.id] ? "rgba(99,102,241,0.2)" : "rgba(99,102,241,0.08)",
                      border: "1px solid rgba(99,102,241,0.3)", color: "#a5b4fc",
                      borderRadius: 7, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                    }}>
                      {expanded[k.id] ? "▲ IPs" : "▼ IPs"}
                    </button>

                    {!k.is_permanent && (
                      <button onClick={() => handleForceLogout(k.id, k.label)} style={{
                        background: "rgba(251,146,60,0.1)", border: "1px solid rgba(251,146,60,0.3)",
                        color: "#fb923c", borderRadius: 7, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                      }}>
                        ⏻ Logout
                      </button>
                    )}

                    {k.is_permanent ? (
                      <button
                        title="Acesso permanente — não pode ser removido"
                        disabled
                        style={{
                          background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.15)",
                          color: "#6b7280", borderRadius: 7, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "not-allowed",
                          opacity: 0.5,
                        }}
                      >
                        Revogar
                      </button>
                    ) : (
                      <button onClick={() => handleDelete(k.id, k.label)} style={{
                        background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
                        color: "#f87171", borderRadius: 7, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                      }}>
                        Revogar
                      </button>
                    )}
                  </div>
                </div>

                {expanded[k.id] && (
                  <div style={{ marginTop: 10, background: "#0f1117", border: "1px solid #2a2d3d", borderRadius: 8, padding: "10px 14px" }}>
                    {loadingLogins[k.id] && <p style={{ color: "#6b7280", fontSize: 12, margin: 0 }}>Carregando…</p>}
                    {!loadingLogins[k.id] && (!logins[k.id] || logins[k.id]!.length === 0) && (
                      <p style={{ color: "#6b7280", fontSize: 12, margin: 0 }}>Nenhum login registrado ainda.</p>
                    )}
                    {!loadingLogins[k.id] && logins[k.id] && logins[k.id]!.length > 0 && (
                      <>
                        <div style={{ color: "#6b7280", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Últimos logins</div>
                        {logins[k.id]!.map((entry, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < logins[k.id]!.length - 1 ? "1px solid #1a1d27" : "none" }}>
                            <span style={{ color: "#e2e8f0", fontSize: 13, fontFamily: "monospace" }}>{entry.ip}</span>
                            <span style={{ color: "#6b7280", fontSize: 11 }}>{new Date(entry.logged_in_at).toLocaleString("pt-BR")}</span>
                          </div>
                        ))}
                      </>
                    )}
                    {k.force_logout_at && (
                      <div style={{ marginTop: 8, color: "#fb923c", fontSize: 11 }}>
                        ⚠ Logout forçado em {new Date(k.force_logout_at).toLocaleString("pt-BR")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit modal */}
      {editKey && (
        <EditModal
          keyItem={editKey}
          instances={instances}
          onClose={() => setEditKey(null)}
          onSaved={() => { load(); }}
        />
      )}
    </div>
  );
}
