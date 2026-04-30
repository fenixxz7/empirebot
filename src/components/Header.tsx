import type { InstanceState } from "@shared/types";

export function Header({ instance }: { instance: InstanceState | null }) {
  const connected = !!instance?.connected;
  const running = !!instance?.running;
  return (
    <div className="card p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <div className="grid place-items-center w-12 h-12 rounded-xl bg-accent/15 ring-1 ring-accent/30">
          <CrownIcon className="w-6 h-6 text-accent" />
        </div>
        <div className="flex-1">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              IMPERIUNS
            </h1>
            <span className="text-[11px] uppercase tracking-[0.3em] text-slate-400">
              Painel de Controle
            </span>
            <a
              href="/stats"
              className="ml-auto text-[11px] uppercase tracking-widest text-violet-400 hover:text-violet-300 transition-colors border border-violet-500/30 hover:border-violet-400/50 rounded-lg px-3 py-1"
            >
              📊 Statistics
            </a>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={connected ? "pill-ok" : "pill-stop"}>
              <Dot className={connected ? "bg-ok" : "bg-danger"} />
              {connected
                ? instance?.user_handle
                  ? `Conectado · ${instance.user_handle}`
                  : "Conectado"
                : "Desconectado"}
            </span>
            <span className={running ? "pill-run" : "pill-stop"}>
              <Dot className={running ? "bg-emerald-400" : "bg-danger"} />
              {running ? "RODANDO" : "PARADO"}
            </span>
            <span className="pill bg-white/5 text-slate-300 ring-1 ring-white/10">
              Instância: <b className="text-white ml-1">{instance?.name ?? "BOT1"}</b>
            </span>
            {instance && instance.tokens_total > 0 && (
              <span className="pill bg-white/5 text-slate-300 ring-1 ring-white/10">
                Tokens:{" "}
                <b className="text-white ml-1">
                  {instance.tokens_active}/{instance.tokens_total}
                </b>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Dot({ className = "" }: { className?: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full ${className}`} />;
}

function CrownIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M3 7l4 4 5-7 5 7 4-4-2 12H5L3 7zm2 14h14v-2H5v2z" />
    </svg>
  );
}
