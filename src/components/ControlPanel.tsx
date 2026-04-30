import type { InstanceState } from "@shared/types";

export function ControlPanel({
  instance,
  onToggle,
}: {
  instance: InstanceState | null;
  onToggle: () => void;
}) {
  const running = !!instance?.running;
  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <PowerIcon className="w-5 h-5 text-accent" />
          Controle — {instance?.name ?? "BOT1"}
        </h2>
      </div>

      <div className="my-8 flex justify-center">
        <button
          onClick={onToggle}
          className={[
            "relative w-44 h-44 rounded-full grid place-items-center transition",
            "ring-2",
            running
              ? "bg-danger/15 ring-danger/40 shadow-glowRed hover:bg-danger/20"
              : "bg-emerald-400/10 ring-emerald-400/40 hover:bg-emerald-400/20",
          ].join(" ")}
          aria-label={running ? "Parar bot" : "Iniciar bot"}
        >
          <span
            className={[
              "absolute inset-3 rounded-full blur-2xl opacity-60",
              running ? "bg-danger/40" : "bg-emerald-400/30",
            ].join(" ")}
          />
          {running ? (
            <SquareIcon className="relative w-16 h-16 text-danger" />
          ) : (
            <PlayIcon className="relative w-16 h-16 text-emerald-300 translate-x-1" />
          )}
        </button>
      </div>

      <p className="text-center text-slate-400 text-sm">
        {running ? "Clique para parar o bot" : "Clique para iniciar o bot"}
      </p>
    </div>
  );
}

function PowerIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.97 6.97 0 0 1 19 12a7 7 0 1 1-12.41-4.41L5.17 6.17A8.99 8.99 0 0 0 3 12a9 9 0 1 0 14.83-6.83z" />
    </svg>
  );
}
function SquareIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
function PlayIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}
