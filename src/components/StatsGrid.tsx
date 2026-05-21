import type { InstanceState } from "@shared/types";
import { fmtUptime } from "@/lib/api";

export function StatsGrid({
  instance,
  onResetStats,
}: {
  instance: InstanceState | null;
  onResetStats: () => void;
}) {
  const s = instance?.stats ?? { entradas: 0, na_fila: 0, partidas: 0, dms: 0, bloqueadas: 0, msgs_enviadas: 0 };
  return (
    <div className="flex flex-col gap-3">
      {/* 2×2 grid on mobile, 2×2 on sm+ (fills the right column) */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
        <StatCard
          icon={<UsersIcon className="w-4 h-4 text-emerald-400" />}
          label="Entradas"
          sub="filas entradas"
          value={s.entradas}
          tone="emerald"
        />
        <StatCard
          icon={<QueueIcon className="w-4 h-4 text-accent" />}
          label="Na Fila"
          sub="filas ativas"
          value={s.na_fila}
          tone="blue"
        />
        <StatCard
          icon={<GamepadIcon className="w-4 h-4 text-fuchsia-400" />}
          label="Partidas"
          sub="encontradas"
          value={s.partidas}
          tone="fuchsia"
        />
        <StatCard
          icon={<SendIcon className="w-4 h-4 text-green-400" />}
          label="Msgs Enviadas"
          sub="confirmadas"
          value={s.msgs_enviadas}
          tone="green"
        />
      </div>

      {/* Uptime + rotation + reset */}
      <div className="card p-3 sm:p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="label flex items-center gap-1.5 mb-1">
            <ClockIcon className="w-3 h-3 text-amber-400" /> Uptime
          </div>
          <div className="font-mono text-xl sm:text-2xl text-amber-300 tabular-nums">
            {fmtUptime(instance?.uptime_seconds ?? 0)}
          </div>
          {instance?.user_handle && (
            <div className="text-[10px] text-slate-600 mt-0.5 truncate max-w-[140px]">
              {instance.user_handle}
            </div>
          )}
        </div>

        {instance?.running && (instance?.tokens_active ?? 0) > 1 && (
          <div>
            <div className="label flex items-center gap-1.5 mb-1">
              <RotateIcon className="w-3 h-3 text-fuchsia-400" /> Próx. rotação
            </div>
            <div className="font-mono text-lg sm:text-xl text-fuchsia-300 tabular-nums">
              {fmtUptime(instance?.next_rotation_seconds ?? 0)}
            </div>
            <div className="text-[10px] text-slate-600 mt-0.5">
              {instance?.tokens_active} tokens
            </div>
          </div>
        )}

        <button onClick={onResetStats} className="btn-ghost text-xs gap-1.5 py-2 px-3">
          <ResetIcon className="w-3.5 h-3.5" />
          Resetar
        </button>
      </div>
    </div>
  );
}

function StatCard({
  icon, label, sub, value, tone,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  value: number;
  tone: "emerald" | "blue" | "fuchsia" | "cyan" | "red" | "green";
}) {
  const numColor = {
    emerald: "text-emerald-300",
    blue: "text-accent",
    fuchsia: "text-fuchsia-300",
    cyan: "text-cyan-300",
    red: "text-red-400",
    green: "text-green-400",
  }[tone];
  return (
    <div className="stat-card">
      <div className="flex items-center gap-1.5 text-slate-400 text-xs font-medium">
        {icon} {label}
      </div>
      <div className={`stat-num ${numColor}`}>{value}</div>
      <div className="text-[10px] text-slate-600">{sub}</div>
    </div>
  );
}

function UsersIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm-8 2c-3.3 0-6 1.8-6 4v3h12v-3c0-2.2-2.7-4-6-4zm10-1a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-1 0-2 .2-2.8.6.5.8.8 1.7.8 2.7v2.7h6v-3c0-1.7-2-3-4-3z"/></svg>);
}
function QueueIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>);
}
function GamepadIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M7 7h10a4 4 0 0 1 4 4v2a4 4 0 0 1-7 2.6L13 15l-1 1-1-1-1 .6A4 4 0 0 1 3 13v-2a4 4 0 0 1 4-4zm0 5h2v-2H7v2zm9 0a1 1 0 1 0-1-1 1 1 0 0 0 1 1zm-2 2a1 1 0 1 0-1-1 1 1 0 0 0 1 1z"/></svg>);
}
function SendIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>);
}
function ClockIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 11h5v-2h-4V6h-2v7z"/></svg>);
}
function ResetIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M12 6V3L7 8l5 5V9a6 6 0 1 1-6 6H4a8 8 0 1 0 8-9z"/></svg>);
}
function RotateIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-3.4-7" /><polyline points="21 4 21 9 16 9" /></svg>);
}
