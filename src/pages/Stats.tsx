import { useEffect, useRef, useState, useCallback } from "react";

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

function EmptyChart({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-white/20 text-sm" style={{ height }}>
      Sem dados para o período
    </div>
  );
}

function LineChart({ points, height = 220 }: { points: TimePoint[]; height?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!points.length) return <EmptyChart height={height} />;

  const VW = 600;
  const VH = height;
  const padL = 10, padR = 10, padT = 14, padB = 30;
  const chartW = VW - padL - padR;
  const chartH = VH - padT - padB;
  const n = points.length;

  const maxE = Math.max(...points.map(p => p.entradas),           1);
  const maxC = Math.max(...points.map(p => p.chats_abertos),      1);
  const maxM = Math.max(...points.map(p => p.mensagens_enviadas), 1);
  const maxes = [maxE, maxC, maxM] as const;

  const xOf = (i: number) => padL + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW);
  const yOf = (val: number, max: number) => padT + chartH - Math.max(0, (val / max)) * chartH;

  const seriesVals = [
    points.map(p => p.entradas),
    points.map(p => p.chats_abertos),
    points.map(p => p.mensagens_enviadas),
  ];

  const makePath = (vals: number[], max: number) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v, max).toFixed(1)}`).join(" ");

  const labelStep = Math.max(1, Math.ceil(n / 10));

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * VW;
    if (n === 1) { setHoverIdx(0); return; }
    const raw = Math.round(((svgX - padL) / chartW) * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, raw)));
  };

  const hoverX = hoverIdx !== null ? xOf(hoverIdx) : null;
  const tooltipLeft = hoverIdx !== null ? Math.min(Math.max(hoverX! / VW * 100, 8), 72) : 50;

  return (
    <div className="relative select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VW} ${VH}`}
        className="w-full"
        style={{ height }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Gridlines */}
        {[0.25, 0.5, 0.75, 1].map(f => (
          <line key={f}
            x1={padL} y1={padT + chartH * (1 - f)}
            x2={VW - padR} y2={padT + chartH * (1 - f)}
            stroke="rgba(255,255,255,0.05)" strokeWidth={1}
          />
        ))}

        {/* X-axis labels */}
        {points.map((p, i) => i % labelStep === 0 && (
          <text key={i}
            x={xOf(i)} y={VH - 6}
            textAnchor="middle" fontSize={9}
            fill="rgba(255,255,255,0.3)"
            fontFamily="monospace"
          >{p.label}</text>
        ))}

        {/* Lines + dots — each series independently normalized */}
        {SERIES.map((s, si) => {
          const vals = seriesVals[si]!;
          const max  = maxes[si];
          return (
            <g key={s.key}>
              <path
                d={makePath(vals, max)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.9}
              />
              {points.map((_, i) => (
                <circle key={i}
                  cx={xOf(i)} cy={yOf(vals[i]!, max)}
                  r={hoverIdx === i ? 5 : 3}
                  fill={s.color}
                  opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.4}
                />
              ))}
            </g>
          );
        })}

        {/* Hover indicator line */}
        {hoverX !== null && (
          <line
            x1={hoverX} y1={padT}
            x2={hoverX} y2={padT + chartH}
            stroke="rgba(255,255,255,0.15)"
            strokeWidth={1}
            strokeDasharray="4,3"
          />
        )}
      </svg>

      {/* Tooltip */}
      {hoverIdx !== null && (
        <div
          className="absolute top-1 z-20 pointer-events-none"
          style={{ left: `${tooltipLeft}%`, transform: "translateX(-50%)" }}
        >
          <div className="bg-[#0d0d20] border border-white/15 rounded-xl px-3 py-2.5 shadow-xl min-w-[160px]">
            <div className="text-xs font-semibold text-white/50 mb-2 text-center">
              {points[hoverIdx]!.label}
            </div>
            {SERIES.map((s, si) => (
              <div key={s.key} className="flex items-center justify-between gap-3 text-xs py-0.5">
                <div className="flex items-center gap-1.5">
                  <span style={{ color: s.color }}>●</span>
                  <span className="text-white/60">{s.label}</span>
                </div>
                <span className="font-bold" style={{ color: s.color }}>
                  {fmt(seriesVals[si]![hoverIdx]!)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
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
              <div className="text-xs text-white/30 mt-0.5">
                Cada série normalizada independentemente — todas ficam visíveis
              </div>
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3 flex-wrap">
              {SERIES.map(s => (
                <div key={s.key} className="flex items-center gap-1.5 text-xs text-white/50">
                  <span className={`inline-block w-3 h-0.5 rounded`} style={{ background: s.color }} />
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
            <LineChart points={timeseries?.points ?? []} height={220} />
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
