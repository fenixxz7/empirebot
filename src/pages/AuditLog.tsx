import { useEffect, useState } from "react";

type AuditEntry = {
  id: number;
  action: string;
  access_key_label: string | null;
  access_key_id: number | null;
  ip: string | null;
  detail: string | null;
  performed_at: string;
};

const ACTION_META: Record<string, { label: string; color: string; icon: string }> = {
  login:          { label: "Login",              color: "#34d399", icon: "✅" },
  login_admin:    { label: "Login admin",        color: "#60a5fa", icon: "🛡️" },
  login_failed:   { label: "Falha no login",     color: "#f87171", icon: "❌" },
  login_expired:  { label: "Login expirado",     color: "#fb923c", icon: "⛔" },
  create:         { label: "Acesso criado",      color: "#a78bfa", icon: "➕" },
  revoke:         { label: "Acesso revogado",    color: "#f87171", icon: "🗑️" },
  force_logout:   { label: "Logout forçado",     color: "#fb923c", icon: "⏻" },
};

function getActionMeta(action: string) {
  return ACTION_META[action] ?? { label: action, color: "#6b7280", icon: "•" };
}

export default function AuditLog() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/audit-logs");
      if (!res.ok) throw new Error();
      setLogs(await res.json());
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = filter
    ? logs.filter(l =>
        l.action.includes(filter) ||
        (l.access_key_label ?? "").toLowerCase().includes(filter.toLowerCase()) ||
        (l.ip ?? "").includes(filter)
      )
    : logs;

  return (
    <div style={{ minHeight: "100vh", background: "#0f1117", padding: "32px 16px", fontFamily: "'Inter', sans-serif" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <a href="/acessos" style={{ color: "#6b7280", fontSize: 13, textDecoration: "none" }}>← Acessos</a>
          <h1 style={{ color: "#f0f0f0", fontSize: 20, fontWeight: 700, margin: 0 }}>📋 Log de Auditoria</h1>
          <button
            onClick={load}
            style={{ marginLeft: "auto", background: "rgba(255,255,255,0.05)", border: "1px solid #2a2d3d", color: "#9ca3af", borderRadius: 7, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}
          >
            ↻ Atualizar
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <input
            style={{
              width: "100%", background: "#1a1d27", border: "1px solid #2a2d3d",
              borderRadius: 8, color: "#f0f0f0", padding: "10px 14px",
              fontSize: 13, outline: "none", boxSizing: "border-box",
            }}
            placeholder="Filtrar por ação, rótulo ou IP…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>

        <div style={{ background: "#1a1d27", border: "1px solid #2a2d3d", borderRadius: 14, overflow: "hidden" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "90px 1fr 1fr 130px 130px",
            padding: "10px 16px",
            borderBottom: "1px solid #2a2d3d",
            color: "#6b7280", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em",
          }}>
            <span>Ação</span>
            <span>Acesso</span>
            <span>IP</span>
            <span>Detalhe</span>
            <span>Data/Hora</span>
          </div>

          {loading && (
            <div style={{ padding: "24px 16px", color: "#6b7280", fontSize: 13 }}>Carregando…</div>
          )}

          {!loading && filtered.length === 0 && (
            <div style={{ padding: "24px 16px", color: "#6b7280", fontSize: 13 }}>Nenhum registro encontrado.</div>
          )}

          {!loading && filtered.map((entry, i) => {
            const meta = getActionMeta(entry.action);
            return (
              <div
                key={entry.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px 1fr 1fr 130px 130px",
                  padding: "10px 16px",
                  borderBottom: i < filtered.length - 1 ? "1px solid #2a2d3d" : "none",
                  alignItems: "center",
                  fontSize: 12,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span>{meta.icon}</span>
                  <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>
                </span>
                <span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.access_key_label ?? <span style={{ color: "#6b7280" }}>—</span>}
                </span>
                <span style={{ color: "#a5b4fc", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.ip ?? <span style={{ color: "#6b7280" }}>—</span>}
                </span>
                <span style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.detail ?? "—"}
                </span>
                <span style={{ color: "#6b7280" }}>
                  {new Date(entry.performed_at).toLocaleString("pt-BR")}
                </span>
              </div>
            );
          })}
        </div>

        {!loading && filtered.length > 0 && (
          <p style={{ color: "#6b7280", fontSize: 11, textAlign: "center", marginTop: 12 }}>
            {filtered.length} registro{filtered.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>
    </div>
  );
}
