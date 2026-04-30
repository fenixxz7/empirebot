import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type LogRow = {
  id: number;
  ts: string;
  level: "INFO" | "WARN" | "ERROR";
  source: string | null;
  message: string;
};

export function LogsConsole({ instanceId }: { instanceId: number }) {
  const [rows, setRows] = useState<LogRow[]>([]);

  async function reload() {
    try {
      const r = await api<LogRow[]>(`/api/logs/${instanceId}?limit=100`);
      setRows(r);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  async function clear() {
    await api(`/api/logs/${instanceId}`, { method: "DELETE" });
    reload();
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold flex items-center gap-2">
          <ChevronIcon className="w-4 h-4 text-emerald-300" />
          Logs <span className="text-slate-500 font-normal">({rows.length})</span>
        </h3>
        <button onClick={clear} className="btn-ghost text-xs px-3 py-1.5">
          <TrashIcon className="w-3.5 h-3.5" /> Limpar
        </button>
      </div>
      <div className="rounded-xl bg-black/60 border border-white/10 p-3 h-[260px] overflow-auto">
        {rows.length === 0 && (
          <div className="text-slate-500 text-sm">Sem logs ainda.</div>
        )}
        {rows.map((r) => {
          const t = new Date(r.ts);
          const hh = String(t.getHours()).padStart(2, "0");
          const mm = String(t.getMinutes()).padStart(2, "0");
          const ss = String(t.getSeconds()).padStart(2, "0");
          const srcCls =
            r.source && /^(gateway|engine|discovery|config|control|worker|match)$/.test(r.source)
              ? `src src-${r.source}`
              : "src src-default";
          return (
            <div key={r.id} className={`log-line log-${r.level}`}>
              <span className="log-time">[{hh}:{mm}:{ss}]</span>{" "}
              <span className={`lvl-${r.level} font-bold`}>{r.level}</span>{" "}
              {r.source && <span className={srcCls}>{r.source}</span>}{" "}
              <span>{r.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChevronIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M6 9l6 6 6-6" /></svg>);
}
function TrashIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-2 6h10l-1 12H8L7 9z"/></svg>);
}
