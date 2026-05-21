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
    <div className="card p-4 sm:p-5 flex flex-col items-center justify-center min-w-[160px]">
      <div className="label flex items-center gap-1.5 mb-4 self-start">
        <PowerIcon className="w-3.5 h-3.5 text-accent" />
        Controle — {instance?.name ?? "BOT1"}
      </div>

      <button
        onClick={onToggle}
        className={[
          "relative w-28 h-28 sm:w-36 sm:h-36 rounded-full grid place-items-center transition-all duration-200",
          "ring-2",
          running
            ? "bg-danger/10 ring-danger/30 hover:bg-danger/15 shadow-glowRed"
            : "bg-emerald-400/[0.07] ring-emerald-400/30 hover:bg-emerald-400/[0.12]",
        ].join(" ")}
        aria-label={running ? "Parar bot" : "Iniciar bot"}
      >
        <span
          className={[
            "absolute inset-4 rounded-full blur-2xl opacity-50",
            running ? "bg-danger/30" : "bg-emerald-400/20",
          ].join(" ")}
        />
        {running ? (
          <SquareIcon className="relative w-10 h-10 sm:w-12 sm:h-12 text-danger" />
        ) : (
          <PlayIcon className="relative w-10 h-10 sm:w-12 sm:h-12 text-emerald-300 translate-x-0.5" />
        )}
      </button>

      <p className="mt-4 text-center text-slate-500 text-xs">
        {running ? "Clique para parar" : "Clique para iniciar"}
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
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
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
