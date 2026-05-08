import { useState } from "react";

export function NovaOrg() {
  const [nome, setNome] = useState("");
  const [guild, setGuild] = useState("");
  const [prioridade, setPrioridade] = useState(1);

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "#0b0f1a" }}
    >
      <div style={{ width: 640 }}>
        <div
          className="rounded-2xl border p-4 space-y-3"
          style={{
            background: "rgba(30,41,59,0.5)",
            borderColor: "rgba(251,146,60,0.3)",
          }}
        >
          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
            <input
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={{
                background: "#0f172a",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#e2e8f0",
              }}
              placeholder="Nome da org (ex: Surf)"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              autoFocus
            />
            <input
              className="rounded-lg px-3 py-2 text-sm font-mono outline-none"
              style={{
                background: "#0f172a",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#94a3b8",
                fontSize: 12,
              }}
              placeholder="guild_id (opcional)"
              value={guild}
              onChange={(e) => setGuild(e.target.value)}
            />
            <div className="flex flex-col gap-0.5">
              <label
                className="text-xs px-1"
                style={{ color: "#64748b" }}
              >
                Prioridade
              </label>
              <input
                type="number"
                min={1}
                max={99}
                className="rounded-lg px-3 py-2 text-sm outline-none text-center"
                style={{
                  background: "#0f172a",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "#e2e8f0",
                  width: 80,
                }}
                value={prioridade}
                onChange={(e) => setPrioridade(Number(e.target.value))}
              />
            </div>
          </div>

          <p className="text-xs px-1" style={{ color: "#475569" }}>
            Maior prioridade = visitada primeiro pelo engine. Orgs com o mesmo número são tratadas igualmente.
          </p>

          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium"
              style={{
                background: "rgba(251,146,60,0.9)",
                color: "#0b0f1a",
              }}
            >
              + Confirmar
            </button>
            <button
              className="rounded-lg px-4 py-2 text-sm"
              style={{ color: "#94a3b8" }}
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
