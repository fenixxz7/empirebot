import { useEffect, useState } from "react";

type AccessKey = { id: number; label: string; created_at: string; force_logout_at: string | null };
type LoginEntry = { ip: string; logged_in_at: string };

export default function AccessKeys() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [logins, setLogins] = useState<Record<number, LoginEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [loadingLogins, setLoadingLogins] = useState<Record<number, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/access-keys");
      if (!res.ok) throw new Error("Sem permissão");
      const data = await res.json();
      setKeys(data);
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

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch("/api/auth/access-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao criar acesso.");
      setLabel("");
      setPassword("");
      await load();
      showFeedback("Acesso criado com sucesso.", true);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Erro.", false);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number, label: string) {
    if (!confirm(`Revogar acesso de "${label}"?`)) return;
    try {
      await fetch(`/api/auth/access-keys/${id}`, { method: "DELETE" });
      await load();
      showFeedback(`Acesso de "${label}" revogado.`, true);
    } catch {
      showFeedback("Erro ao revogar acesso.", false);
    }
  }

  async function handleForceLogout(id: number, label: string) {
    if (!confirm(`Forçar logout de todas as sessões ativas de "${label}"?`)) return;
    try {
      const res = await fetch(`/api/auth/access-keys/${id}/force-logout`, { method: "POST" });
      if (!res.ok) throw new Error();
      await load();
      showFeedback(`Sessões de "${label}" encerradas.`, true);
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

  return (
    <div style={{ minHeight: "100vh", background: "#0f1117", padding: "32px 16px", fontFamily: "'Inter', sans-serif" }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <a href="/" style={{ color: "#6b7280", fontSize: 13, textDecoration: "none" }}>← Voltar</a>
          <h1 style={{ color: "#f0f0f0", fontSize: 20, fontWeight: 700, margin: 0 }}>
            🔑 Acessos temporários
          </h1>
        </div>

        <div style={{ background: "#1a1d27", border: "1px solid #2a2d3d", borderRadius: 14, padding: 24, marginBottom: 24 }}>
          <p style={{ color: "#9ca3af", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
            Crie senhas extras para liberar acesso ao painel. Cada acesso pode ser revogado individualmente sem alterar a senha principal.
          </p>

          <form onSubmit={handleAdd}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Rótulo (quem é)
                </label>
                <input
                  style={inputStyle}
                  placeholder="Ex: João"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  required
                />
              </div>
              <div>
                <label style={{ display: "block", color: "#9ca3af", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Senha
                </label>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder="Mínimo 4 caracteres"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={4}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={adding}
              style={{
                marginTop: 14,
                background: adding ? "#92400e" : "linear-gradient(135deg, #f59e0b, #d97706)",
                color: "#0f1117",
                border: "none",
                borderRadius: 8,
                padding: "10px 22px",
                fontSize: 13,
                fontWeight: 700,
                cursor: adding ? "not-allowed" : "pointer",
                opacity: adding ? 0.7 : 1,
              }}
            >
              {adding ? "Criando…" : "+ Criar acesso"}
            </button>
          </form>

          {feedback && (
            <div style={{
              marginTop: 14,
              padding: "10px 14px",
              borderRadius: 8,
              fontSize: 13,
              background: feedback.ok ? "rgba(52,211,153,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${feedback.ok ? "rgba(52,211,153,0.3)" : "rgba(239,68,68,0.3)"}`,
              color: feedback.ok ? "#6ee7b7" : "#fca5a5",
            }}>
              {feedback.msg}
            </div>
          )}
        </div>

        <div style={{ background: "#1a1d27", border: "1px solid #2a2d3d", borderRadius: 14, padding: 24 }}>
          <h2 style={{ color: "#f0f0f0", fontSize: 15, fontWeight: 600, margin: "0 0 16px" }}>
            Acessos ativos ({keys.length})
          </h2>

          {loading && <p style={{ color: "#6b7280", fontSize: 13 }}>Carregando…</p>}

          {!loading && keys.length === 0 && (
            <p style={{ color: "#6b7280", fontSize: 13, margin: 0 }}>Nenhum acesso temporário criado ainda.</p>
          )}

          {!loading && keys.map(k => (
            <div key={k.id} style={{
              borderBottom: "1px solid #2a2d3d",
              paddingBottom: 12,
              marginBottom: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: "#f0f0f0", fontSize: 14, fontWeight: 600 }}>{k.label}</div>
                  <div style={{ color: "#6b7280", fontSize: 12, marginTop: 2 }}>
                    Criado em {new Date(k.created_at).toLocaleString("pt-BR")}
                  </div>
                </div>

                <button
                  onClick={() => toggleLogins(k.id)}
                  title="Ver IPs de login"
                  style={{
                    background: expanded[k.id] ? "rgba(99,102,241,0.2)" : "rgba(99,102,241,0.08)",
                    border: "1px solid rgba(99,102,241,0.3)",
                    color: "#a5b4fc",
                    borderRadius: 7,
                    padding: "5px 11px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {expanded[k.id] ? "▲ IPs" : "▼ IPs"}
                </button>

                <button
                  onClick={() => handleForceLogout(k.id, k.label)}
                  title="Forçar logout de todas as sessões ativas"
                  style={{
                    background: "rgba(251,146,60,0.1)",
                    border: "1px solid rgba(251,146,60,0.3)",
                    color: "#fb923c",
                    borderRadius: 7,
                    padding: "5px 11px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  ⏻ Logout
                </button>

                <button
                  onClick={() => handleDelete(k.id, k.label)}
                  style={{
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    color: "#f87171",
                    borderRadius: 7,
                    padding: "5px 11px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Revogar
                </button>
              </div>

              {expanded[k.id] && (
                <div style={{
                  marginTop: 10,
                  background: "#0f1117",
                  border: "1px solid #2a2d3d",
                  borderRadius: 8,
                  padding: "10px 14px",
                }}>
                  {loadingLogins[k.id] && (
                    <p style={{ color: "#6b7280", fontSize: 12, margin: 0 }}>Carregando…</p>
                  )}
                  {!loadingLogins[k.id] && (!logins[k.id] || logins[k.id]!.length === 0) && (
                    <p style={{ color: "#6b7280", fontSize: 12, margin: 0 }}>Nenhum login registrado ainda.</p>
                  )}
                  {!loadingLogins[k.id] && logins[k.id] && logins[k.id]!.length > 0 && (
                    <div>
                      <div style={{ color: "#6b7280", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                        Últimos logins
                      </div>
                      {logins[k.id]!.map((entry, i) => (
                        <div key={i} style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "4px 0",
                          borderBottom: i < logins[k.id]!.length - 1 ? "1px solid #1a1d27" : "none",
                        }}>
                          <span style={{ color: "#e2e8f0", fontSize: 13, fontFamily: "monospace" }}>{entry.ip}</span>
                          <span style={{ color: "#6b7280", fontSize: 11 }}>
                            {new Date(entry.logged_in_at).toLocaleString("pt-BR")}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {k.force_logout_at && (
                    <div style={{ marginTop: 8, color: "#fb923c", fontSize: 11 }}>
                      ⚠ Logout forçado em {new Date(k.force_logout_at).toLocaleString("pt-BR")} — sessões anteriores a este horário foram encerradas.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
