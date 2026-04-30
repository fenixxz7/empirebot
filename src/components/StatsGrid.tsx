import type { InstanceState } from "@shared/types";
import { fmtUptime } from "@/lib/api";

export function StatsGrid({
  instance,
  onResetStats,
}: {
  instance: InstanceState | null;
  onResetStats: () => void;
}) {
  const s = instance?.stats ?? { entradas: 0, na_fila: 0, partidas: 0, dms: 0, bloqueadas: 0 };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          icon={<UsersIcon className="w-5 h-5 text-emerald-300" />}
          label="Entradas"
          sub="filas entradas"
          value={s.entradas}
          tone="emerald"
        />
        <StatCard
          icon={<GamepadIcon className="w-5 h-5 text-accent" />}
          label="Na Fila"
          sub="filas ativas"
          value={s.na_fila}
          tone="blue"
        />
        <StatCard
          icon={<GamepadIcon className="w-5 h-5 text-fuchsia-300" />}
          label="Partidas"
          sub="encontradas"
          value={s.partidas}
          tone="fuchsia"
        />
        <StatCard
          icon={<MailIcon className="w-5 h-5 text-cyan-300" />}
          label="DMs"
          sub="detectadas"
          value={s.dms}
          tone="cyan"
        />
        <StatCard
          icon={<ShieldIcon className="w-5 h-5 text-red-400" />}
          label="Bloqueadas"
          sub="filas evitadas"
          value={s.bloqueadas}
          tone="red"
        />
      </div>

      <div className="card p-5 flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="label flex items-center gap-2">
            <ClockIcon className="w-4 h-4 text-amber-300" /> Uptime
          </div>
          <div className="mt-1 font-mono text-3xl text-amber-300 tabular-nums">
            {fmtUptime(instance?.uptime_seconds ?? 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {instance?.user_handle ?? "—"}
          </div>
        </div>
        {instance?.running && (instance?.tokens_active ?? 0) > 1 && (
          <div>
            <div className="label flex items-center gap-2">
              <RotateIcon className="w-4 h-4 text-fuchsia-300" /> Próxima rotação
            </div>
            <div className="mt-1 font-mono text-2xl text-fuchsia-300 tabular-nums">
              {fmtUptime(instance?.next_rotation_seconds ?? 0)}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              ciclo entre {instance?.tokens_active} token(s)
            </div>
          </div>
        )}
        <button onClick={onResetStats} className="btn-ghost">
          <ResetIcon className="w-4 h-4" />
          Resetar Stats
        </button>
      </div>
    </div>
  );
}

function StatCard({
  icon, label, sub, value, tone,
}: {
  icon: React.ReactNode;
  label: string; sub: string; value: number;
  tone: "emerald" | "blue" | "fuchsia" | "cyan" | "red";
}) {
  const numColor = {
    emerald: "text-emerald-300",
    blue: "text-accent",
    fuchsia: "text-fuchsia-300",
    cyan: "text-cyan-300",
    red: "text-red-400",
  }[tone];
  return (
    <div className="stat-card">
      <div className="flex items-center gap-2 text-slate-300 text-sm font-medium">
        {icon} {label}
      </div>
      <div className={`stat-num ${numColor}`}>{value}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function UsersIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm-8 2c-3.3 0-6 1.8-6 4v3h12v-3c0-2.2-2.7-4-6-4zm10-1a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-1 0-2 .2-2.8.6.5.8.8 1.7.8 2.7v2.7h6v-3c0-1.7-2-3-4-3z"/></svg>);
}
function GamepadIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M7 7h10a4 4 0 0 1 4 4v2a4 4 0 0 1-7 2.6L13 15l-1 1-1-1-1 .6A4 4 0 0 1 3 13v-2a4 4 0 0 1 4-4zm0 5h2v-2H7v2zm9 0a1 1 0 1 0-1-1 1 1 0 0 0 1 1zm-2 2a1 1 0 1 0-1-1 1 1 0 0 0 1 1z"/></svg>);
}
function MailIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4h15A2.5 2.5 0 0 1 22 6.5v11A2.5 2.5 0 0 1 19.5 20h-15A2.5 2.5 0 0 1 2 17.5v-11zm2.4-.5l7.6 6 7.6-6H4.4z"/></svg>);
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
function ShieldIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6l-8-4zm0 10h-1V8h2v4h-1zm0 4h-2v-2h2v2z"/></svg>);
}
