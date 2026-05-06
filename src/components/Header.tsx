import type { InstanceState } from "@shared/types";

export function Header({ instance, isAdmin = false }: { instance: InstanceState | null; isAdmin?: boolean }) {
  const connected = !!instance?.connected;
  const running = !!instance?.running;
  return (
    <div className="card p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <EmpireLogo />
        <div className="flex-1">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 bg-clip-text text-transparent">
              EMPIRE
            </h1>
            <span className="text-[11px] uppercase tracking-[0.3em] text-slate-400">
              Painel de Controle
            </span>
            <div className="ml-auto flex gap-2">
              {isAdmin && (
                <>
                  <a
                    href="/acessos"
                    className="text-[11px] uppercase tracking-widest text-amber-400 hover:text-amber-300 transition-colors border border-amber-500/30 hover:border-amber-400/50 rounded-lg px-3 py-1"
                  >
                    🔑 Acessos
                  </a>
                  <a
                    href="/auditoria"
                    className="text-[11px] uppercase tracking-widest text-violet-400 hover:text-violet-300 transition-colors border border-violet-500/30 hover:border-violet-400/50 rounded-lg px-3 py-1"
                  >
                    📋 Auditoria
                  </a>
                </>
              )}
              <a
                href="/stats"
                className="text-[11px] uppercase tracking-widest text-violet-400 hover:text-violet-300 transition-colors border border-violet-500/30 hover:border-violet-400/50 rounded-lg px-3 py-1"
              >
                📊 Statistics
              </a>
            </div>
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

function EmpireLogo() {
  return (
    <div className="relative shrink-0 w-12 h-12">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-lg">
        <defs>
          <linearGradient id="shieldGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fbbf24" />
            <stop offset="50%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#d97706" />
          </linearGradient>
          <linearGradient id="shieldGloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Shield shape */}
        <path
          d="M24 3L6 10v14c0 9.5 7.5 18.4 18 21 10.5-2.6 18-11.5 18-21V10L24 3z"
          fill="url(#shieldGrad)"
        />
        {/* Gloss overlay */}
        <path
          d="M24 3L6 10v14c0 1 .05 2 .15 3L24 10.5 41.85 27c.1-1 .15-2 .15-3V10L24 3z"
          fill="url(#shieldGloss)"
        />
        {/* Bold E letter */}
        <text
          x="24"
          y="31"
          textAnchor="middle"
          fontFamily="Arial Black, Arial, sans-serif"
          fontWeight="900"
          fontSize="22"
          fill="#1a0a00"
          letterSpacing="-1"
        >
          E
        </text>
      </svg>
    </div>
  );
}
