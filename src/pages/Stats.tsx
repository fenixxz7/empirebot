import { useEffect, useState, useCallback } from "react";

type Period = "today" | "week" | "month" | "all";

interface OrgStat {
  org_name: string;
  entradas: number;
  partidas: number;
}

interface Summary {
  entradas: number;
  partidas: number;
  by_mode: { mode: string; n: number }[];
}

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "week", label: "7 dias" },
  { value: "month", label: "30 dias" },
  { value: "all", label: "Tudo" },
];

function medal(i: number) {
  if (i === 0) return "🥇";
  if (i === 1) return "🥈";
  if (i === 2) return "🥉";
  return `#${i + 1}`;
}

export default function Stats() {
  const [period, setPeriod] = useState<Period>("week");
  const [sortBy, setSortBy] = useState<"entradas" | "partidas">("entradas");
  const [orgs, setOrgs] = useState<OrgStat[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, sumRes] = await Promise.all([
        fetch(`/api/stats/orgs?period=${period}`),
        fetch(`/api/stats/summary?period=${period}`),
      ]);
      if (orgRes.ok) setOrgs(await orgRes.json());
      if (sumRes.ok) setSummary(await sumRes.json());
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [period]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await fetch("/api/stats/reset", { method: "DELETE" });
      setConfirmReset(false);
      await load();
    } finally {
      setResetting(false);
    }
  }, [load]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const sorted = [...orgs].sort((a, b) => b[sortBy] - a[sortBy]);
  const maxVal = sorted[0]?.[sortBy] ?? 1;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white font-sans">
      {/* Header */}
      <div className="border-b border-white/10 bg-[#0d0d18]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 drop-shadow">
              <defs>
                <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" />
                  <stop offset="100%" stopColor="#d97706" />
                </linearGradient>
              </defs>
              <path d="M24 3L6 10v14c0 9.5 7.5 18.4 18 21 10.5-2.6 18-11.5 18-21V10L24 3z" fill="url(#sg)" />
              <text x="24" y="31" textAnchor="middle" fontFamily="Arial Black,Arial,sans-serif" fontWeight="900" fontSize="22" fill="#1a0a00">E</text>
            </svg>
            <div>
              <div className="text-sm font-bold tracking-widest text-amber-400 uppercase">Empire</div>
              <div className="text-xs text-white/40">Statistics · Ranking de Orgs</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="text-xs text-white/40 hover:text-white/70 transition-colors border border-white/10 hover:border-white/20 rounded-lg px-3 py-1.5"
            >
              ← Painel
            </a>
            <button
              onClick={load}
              disabled={loading}
              className="text-xs text-white/40 hover:text-white/70 transition-colors border border-white/10 hover:border-white/20 rounded-lg px-3 py-1.5 disabled:opacity-40"
            >
              {loading ? "…" : "↻ Atualizar"}
            </button>
            <button
              onClick={() => setConfirmReset(true)}
              className="text-xs text-red-400/70 hover:text-red-400 transition-colors border border-red-500/20 hover:border-red-500/40 rounded-lg px-3 py-1.5"
            >
              🗑 Resetar
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-xl border border-white/10 overflow-hidden">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-4 py-2 text-sm font-medium transition-all ${
                  period === p.value
                    ? "bg-violet-600 text-white"
                    : "text-white/40 hover:text-white/70 hover:bg-white/5"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-xl border border-white/10 overflow-hidden ml-auto">
            <button
              onClick={() => setSortBy("entradas")}
              className={`px-4 py-2 text-sm font-medium transition-all ${
                sortBy === "entradas"
                  ? "bg-cyan-600 text-white"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5"
              }`}
            >
              Por Entradas
            </button>
            <button
              onClick={() => setSortBy("partidas")}
              className={`px-4 py-2 text-sm font-medium transition-all ${
                sortBy === "partidas"
                  ? "bg-pink-600 text-white"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5"
              }`}
            >
              Por Partidas
            </button>
          </div>
        </div>

        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="text-xs text-white/40 uppercase tracking-wider mb-1">Entradas</div>
              <div className="text-3xl font-bold text-cyan-400">{summary.entradas.toLocaleString("pt-BR")}</div>
              <div className="text-xs text-white/30 mt-1">filas entradas</div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="text-xs text-white/40 uppercase tracking-wider mb-1">Partidas</div>
              <div className="text-3xl font-bold text-pink-400">{summary.partidas.toLocaleString("pt-BR")}</div>
              <div className="text-xs text-white/30 mt-1">chats abertos</div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="text-xs text-white/40 uppercase tracking-wider mb-1">Taxa</div>
              <div className="text-3xl font-bold text-violet-400">
                {summary.entradas > 0
                  ? `${((summary.partidas / summary.entradas) * 100).toFixed(1)}%`
                  : "—"}
              </div>
              <div className="text-xs text-white/30 mt-1">partidas / entradas</div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="text-xs text-white/40 uppercase tracking-wider mb-1">Orgs ativas</div>
              <div className="text-3xl font-bold text-amber-400">{orgs.length}</div>
              <div className="text-xs text-white/30 mt-1">no período</div>
            </div>
          </div>
        )}

        {/* Mode breakdown */}
        {summary && summary.by_mode.length > 0 && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <div className="text-xs text-white/40 uppercase tracking-wider mb-3">Entradas por modo</div>
            <div className="flex flex-wrap gap-2">
              {summary.by_mode.map((m) => (
                <div key={m.mode} className="flex items-center gap-2 bg-white/5 rounded-xl px-3 py-1.5">
                  <span className="text-xs font-mono text-white/60">{m.mode}</span>
                  <span className="text-sm font-bold text-white">{m.n.toLocaleString("pt-BR")}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Org ranking */}
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
            <div className="text-sm font-semibold text-white/80">Ranking de Orgs</div>
            {lastUpdated && (
              <div className="text-xs text-white/30">
                Atualizado às {lastUpdated.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            )}
          </div>

          {loading && orgs.length === 0 ? (
            <div className="px-6 py-12 text-center text-white/30 text-sm">Carregando…</div>
          ) : sorted.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <div className="text-white/20 text-4xl mb-3">📭</div>
              <div className="text-white/40 text-sm">Nenhum dado para este período</div>
              <div className="text-white/20 text-xs mt-1">O bot precisa estar rodando para gerar estatísticas</div>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {sorted.map((org, i) => {
                const barWidth = maxVal > 0 ? (org[sortBy] / maxVal) * 100 : 0;
                return (
                  <div key={org.org_name} className="px-6 py-4 flex items-center gap-4 hover:bg-white/3 transition-colors">
                    <div className="w-10 text-center text-lg font-bold shrink-0">{medal(i)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="font-medium text-white truncate">{org.org_name}</div>
                        <div className="flex items-center gap-4 shrink-0 ml-4">
                          <div className="text-right">
                            <div className="text-xs text-white/40">Entradas</div>
                            <div className="text-sm font-bold text-cyan-400">{org.entradas.toLocaleString("pt-BR")}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-white/40">Partidas</div>
                            <div className="text-sm font-bold text-pink-400">{org.partidas.toLocaleString("pt-BR")}</div>
                          </div>
                          <div className="text-right w-12">
                            <div className="text-xs text-white/40">Taxa</div>
                            <div className="text-sm font-bold text-violet-400">
                              {org.entradas > 0 ? `${((org.partidas / org.entradas) * 100).toFixed(0)}%` : "—"}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            sortBy === "entradas" ? "bg-cyan-500" : "bg-pink-500"
                          }`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Confirm reset modal */}
      {confirmReset && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d0d18] border border-red-500/30 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="text-2xl mb-2">⚠️</div>
            <div className="text-white font-semibold text-lg mb-1">Resetar estatísticas?</div>
            <div className="text-white/50 text-sm mb-6">
              Isso apaga <b className="text-white/70">todo o histórico</b> de entradas e partidas. A ação não pode ser desfeita.
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmReset(false)}
                disabled={resetting}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/50 hover:text-white/80 hover:border-white/20 text-sm transition-all disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                onClick={handleReset}
                disabled={resetting}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all disabled:opacity-40"
              >
                {resetting ? "Resetando…" : "Sim, resetar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
