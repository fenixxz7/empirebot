import { useEffect, useState, useCallback } from "react";

type Period = "today" | "week" | "month" | "all";
type SortKey = "entradas" | "chats" | "mensagens";

interface OrgStat {
  org_name: string;
  entradas: number;
  chats_abertos: number;
  mensagens_enviadas: number;
}

interface Summary {
  entradas: number;
  chats_abertos: number;
  mensagens_enviadas: number;
  orgs_ativas: number;
}

interface TimePoint {
  label: string;
  entradas: number;
  chats_abertos: number;
  mensagens_enviadas: number;
}

interface Timeseries {
  granularity: "hour" | "day";
  points: TimePoint[];
}

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "week",  label: "7 dias" },
  { value: "month", label: "30 dias" },
  { value: "all",   label: "Tudo" },
];

const SORTS: { value: SortKey; label: string }[] = [
  { value: "entradas",  label: "Entradas" },
  { value: "chats",     label: "Chats" },
  { value: "mensagens", label: "Mensagens" },
];

const SERIES = [
  { key: "entradas"          as keyof TimePoint, label: "Entradas",           color: "#22d3ee", bg: "bg-cyan-400" },
  { key: "chats_abertos"     as keyof TimePoint, label: "Chats abertos",      color: "#fb923c", bg: "bg-orange-400" },
  { key: "mensagens_enviadas"as keyof TimePoint, label: "Mensagens enviadas", color: "#4ade80", bg: "bg-green-400" },
] as const;

function pct(num: number, den: number) {
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function fmt(n: number | undefined | null) {
  if (n == null || isNaN(n as number)) return "0";
  return (n as number).toLocaleString("pt-BR");
}

function medal(i: number) {
  if (i === 0) return "🥇";
  if (i === 1) return "🥈";
  if (i === 2) return "🥉";
  return `#${i + 1}`;
}

function GroupedBarChart({ points, height = 240 }: { points: TimePoint[]; height?: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!points.length) {
    return (
      <div className="flex items-center justify-center text-white/20 text-sm" style={{ height }}>
        Sem dados para o período
      </div>
    );
  }

  const VW = 560;
  const VH = height;
  const padL = 40, padR = 12, padT = 14, padB = 30;
  const chartW = VW - padL - padR;
  const chartH = VH - padT - padB;
  const n = points.length;

  // Eixo Y compartilhado com valores reais
  const rawMax = Math.max(
    ...points.map(p => p.entradas),
    ...points.map(p => p.chats_abertos),
    ...points.map(p => p.mensagens_enviadas),
    1,
  );
  // Arredonda para cima para um valor "limpo"
  const yMax = (() => {
    const nice = [1,2,5,10,15,20,25,30,40,50,75,100,150,200,300,500,750,1000,1500,2000,5000];
    const target = rawMax * 1.18;
    return nice.find(c => c >= target) ?? Math.ceil(target / 100) * 100;
  })();

  const yOf = (val: number) => padT + chartH - (val / yMax) * chartH;

  // Ticks do eixo Y (4 linhas)
  const yTicks = [0.25, 0.5, 0.75, 1.0].map(f => Math.round(yMax * f));

  // Dimensões das barras
  const slotW = chartW / n;
  const barW  = Math.min(28, Math.max(6, slotW * 0.22));
  const barGap = Math.max(2, barW * 0.18);
  const groupW = 3 * barW + 2 * barGap;

  const xCenter = (i: number) => padL + (i + 0.5) * slotW;
  const barLeft = (i: number, si: number) => xCenter(i) - groupW / 2 + si * (barW + barGap);

  const colors = ["#22d3ee", "#fb923c", "#4ade80"] as const;
  const seriesKeys: (keyof TimePoint)[] = ["entradas", "chats_abertos", "mensagens_enviadas"];

  const labelStep = Math.max(1, Math.ceil(n / 12));

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * VW;
    const idx = Math.floor((svgX - padL) / slotW);
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  const hp = hoverIdx !== null ? points[hoverIdx]! : null;
  const tooltipPct = hoverIdx !== null
    ? Math.min(Math.max(xCenter(hoverIdx) / VW * 100, 12), 76)
    : 50;

  return (
    <div className="relative select-none overflow-x-auto">
      <div style={{ minWidth: Math.max(400, n * 40 + padL + padR) }}>
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          width="100%"
          height={height}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Gridlines + eixo Y */}
          {yTicks.map(tick => {
            const y = yOf(tick);
            return (
              <g key={tick}>
                <line x1={padL} y1={y} x2={VW - padR} y2={y}
                  stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                <text x={padL - 6} y={y + 3.5}
                  textAnchor="end" fontSize={9}
                  fill="rgba(255,255,255,0.35)" fontFamily="monospace">
                  {tick}
                </text>
              </g>
            );
          })}

          {/* Baseline */}
          <line x1={padL} y1={padT + chartH} x2={VW - padR} y2={padT + chartH}
            stroke="rgba(255,255,255,0.15)" strokeWidth={1} />

          {/* Barras + labels */}
          {points.map((pt, i) => {
            const hov = hoverIdx === i;
            return (
              <g key={i}>
                {/* Fundo de hover */}
                {hov && (
                  <rect x={padL + i * slotW + 1} y={padT}
                    width={slotW - 2} height={chartH}
                    fill="rgba(255,255,255,0.04)" rx={3} />
                )}

                {/* 3 barras agrupadas */}
                {seriesKeys.map((key, si) => {
                  const val = pt[key] as number;
                  const h = val > 0 ? Math.max(3, (val / yMax) * chartH) : 0;
                  return (
                    <rect key={si}
                      x={barLeft(i, si)}
                      y={padT + chartH - h}
                      width={barW}
                      height={h}
                      rx={Math.min(3, barW / 3)}
                      fill={colors[si]}
                      opacity={hov || hoverIdx === null ? 0.88 : 0.38}
                    />
                  );
                })}

                {/* Label do eixo X */}
                {i % labelStep === 0 && (
                  <text x={xCenter(i)} y={VH - 8}
                    textAnchor="middle" fontSize={9}
                    fill="rgba(255,255,255,0.38)" fontFamily="monospace">
                    {pt.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hp && hoverIdx !== null && (
          <div className="absolute top-2 pointer-events-none z-20"
            style={{ left: `${tooltipPct}%`, transform: "translateX(-50%)" }}>
            <div className="bg-[#10101e] border border-white/15 rounded-xl px-3.5 py-2.5 shadow-2xl min-w-[172px]">
              <div className="text-xs font-semibold text-white/45 mb-2 text-center pb-1.5 border-b border-white/8">
                {hp.label}
              </div>
              {SERIES.map((s, si) => (
                <div key={si} className="flex items-center justify-between gap-4 py-0.5">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
                    <span className="text-white/60">{s.label}</span>
                  </div>
                  <span className="text-sm font-bold tabular-nums" style={{ color: s.color }}>
                    {fmt(hp[s.key] as number)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Stats() {
  const [period, setPeriod]           = useState<Period>("today");
  const [sortBy, setSortBy]           = useState<SortKey>("entradas");
  const [orgs, setOrgs]               = useState<OrgStat[]>([]);
  const [summary, setSummary]         = useState<Summary | null>(null);
  const [timeseries, setTimeseries]   = useState<Timeseries | null>(null);
  const [loading, setLoading]         = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [resetting, setResetting]     = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, sumRes, tsRes] = await Promise.all([
        fetch(`/api/stats/orgs?period=${period}&sort=${sortBy}`),
        fetch(`/api/stats/summary?period=${period}`),
        fetch(`/api/stats/timeseries?period=${period}`),
      ]);
      if (orgRes.ok) setOrgs(await orgRes.json());
      if (sumRes.ok) setSummary(await sumRes.json());
      if (tsRes.ok)  setTimeseries(await tsRes.json());
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [period, sortBy]);

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

  const sum = summary;
  const taxaEnvio      = sum ? pct(sum.mensagens_enviadas, sum.chats_abertos) : "—";
  const taxaConversao  = sum ? pct(sum.chats_abertos, sum.entradas)           : "—";

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
              <div className="text-xs text-white/40">Statistics · Histórico de atividade</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-xs text-white/20 mr-1">
                {lastUpdated.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
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
              Resetar
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* Period selector */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-xl border border-white/10 overflow-hidden">
            {PERIODS.map(p => (
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
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 col-span-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Entradas</div>
            <div className="text-2xl font-bold text-cyan-400">{sum ? fmt(sum.entradas) : "—"}</div>
            <div className="text-[10px] text-white/25 mt-0.5">filas entradas</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 col-span-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Chats abertos</div>
            <div className="text-2xl font-bold text-orange-400">{sum ? fmt(sum.chats_abertos) : "—"}</div>
            <div className="text-[10px] text-white/25 mt-0.5">partidas detectadas</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 col-span-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Msgs enviadas</div>
            <div className="text-2xl font-bold text-green-400">{sum ? fmt(sum.mensagens_enviadas) : "—"}</div>
            <div className="text-[10px] text-white/25 mt-0.5">msg_sent = TRUE</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 col-span-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Taxa de envio</div>
            <div className="text-2xl font-bold text-violet-400">{taxaEnvio}</div>
            <div className="text-[10px] text-white/25 mt-0.5">msgs / chats</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 col-span-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Taxa conversão</div>
            <div className="text-2xl font-bold text-amber-400">{taxaConversao}</div>
            <div className="text-[10px] text-white/25 mt-0.5">chats / entradas</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 col-span-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Orgs ativas</div>
            <div className="text-2xl font-bold text-pink-400">{sum ? fmt(sum.orgs_ativas) : "—"}</div>
            <div className="text-[10px] text-white/25 mt-0.5">no período</div>
          </div>
        </div>

        {/* Chart */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <div className="text-sm font-semibold text-white/80">
                {period === "today" ? "Atividade por hora (24h)" :
                 period === "week"  ? "Atividade por dia (7 dias)" :
                 period === "month" ? "Atividade por dia (30 dias)" :
                                     "Histórico completo (por dia)"}
              </div>
            </div>
            {/* Legend */}
            <div className="flex items-center gap-4 flex-wrap">
              {SERIES.map(s => (
                <div key={s.key} className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color, opacity: 0.85 }} />
                  <span style={{ color: s.color }}>{s.label}</span>
                </div>
              ))}
            </div>
          </div>
          {loading && !timeseries ? (
            <div className="flex items-center justify-center text-white/20 text-sm" style={{ height: 220 }}>
              Carregando…
            </div>
          ) : (
            <GroupedBarChart points={timeseries?.points ?? []} height={240} />
          )}
        </div>

        {/* Org ranking */}
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm font-semibold text-white/80">Ranking de Orgs</div>
            <div className="flex rounded-xl border border-white/10 overflow-hidden">
              {SORTS.map(s => (
                <button
                  key={s.value}
                  onClick={() => setSortBy(s.value)}
                  className={`px-3 py-1.5 text-xs font-medium transition-all ${
                    sortBy === s.value
                      ? "bg-violet-700 text-white"
                      : "text-white/40 hover:text-white/70 hover:bg-white/5"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {loading && orgs.length === 0 ? (
            <div className="px-6 py-12 text-center text-white/30 text-sm">Carregando…</div>
          ) : orgs.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <div className="text-white/20 text-4xl mb-3">📭</div>
              <div className="text-white/40 text-sm">Nenhum dado para este período</div>
              <div className="text-white/20 text-xs mt-1">O bot precisa estar rodando para gerar estatísticas</div>
            </div>
          ) : (
            <>
              {/* Table header */}
              <div className="grid grid-cols-[auto_1fr_repeat(5,_auto)] gap-x-4 px-6 py-2 border-b border-white/5 text-[10px] text-white/30 uppercase tracking-wider">
                <span>#</span>
                <span>Org</span>
                <span className="text-right text-cyan-400/60">Entradas</span>
                <span className="text-right text-orange-400/60">Chats</span>
                <span className="text-right text-green-400/60">Msgs</span>
                <span className="text-right text-amber-400/60">Chats/Ent</span>
                <span className="text-right text-violet-400/60">Msgs/Chat</span>
              </div>
              <div className="divide-y divide-white/5">
                {orgs.map((org, i) => (
                  <div
                    key={org.org_name}
                    className="grid grid-cols-[auto_1fr_repeat(5,_auto)] gap-x-4 px-6 py-3 items-center hover:bg-white/[0.03] transition-colors text-sm"
                  >
                    <span className="text-base w-8">{medal(i)}</span>
                    <span className="font-medium text-white truncate">{org.org_name}</span>
                    <span className="font-bold text-cyan-400 text-right tabular-nums">{fmt(org.entradas)}</span>
                    <span className="font-bold text-orange-400 text-right tabular-nums">{fmt(org.chats_abertos)}</span>
                    <span className="font-bold text-green-400 text-right tabular-nums">{fmt(org.mensagens_enviadas)}</span>
                    <span className="text-amber-300 text-right tabular-nums text-xs">{pct(org.chats_abertos, org.entradas)}</span>
                    <span className="text-violet-300 text-right tabular-nums text-xs">{pct(org.mensagens_enviadas, org.chats_abertos)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Confirm reset modal */}
      {confirmReset && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d0d18] border border-red-500/30 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="text-white font-semibold text-lg mb-2">Resetar estatísticas?</div>
            <div className="text-white/50 text-sm mb-5">
              Apaga <b className="text-white/70">todo o histórico</b> de entradas e partidas desta página.
              O painel principal continua funcionando normalmente.
              <br /><br />
              <span className="text-white/30 text-xs">Ação irreversível.</span>
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
                {resetting ? "Apagando…" : "Sim, apagar histórico"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
