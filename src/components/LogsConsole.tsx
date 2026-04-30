import { useEffect, useRef, useState } from "react";
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
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${instanceId}`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "log") {
          const p = msg.payload as LogRow;
          setRows((prev) => {
            const next = [p, ...prev];
            return next.slice(0, 200);
          });
        }
      } catch { /* noop */ }
    };

    ws.onclose = () => {
      // Fallback: poll every 4s if WS drops
      const t = setInterval(reload, 4000);
      return () => clearInterval(t);
    };
    ws.onerror = () => ws.close();

    return () => {
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  async function clear() {
    await api(`/api/logs/${instanceId}`, { method: "DELETE" });
    setRows([]);
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
      <div className="rounded-xl bg-black/60 border border-white/10 p-3 h-[260px] overflow-auto flex flex-col-reverse">
        {rows.length === 0 && (
          <div className="text-slate-500 text-sm">Sem logs ainda.</div>
        )}
        <div>
          {[...rows].reverse().map((r) => {
            const srcCls =
              r.source &&
              /^(gateway|engine|discovery|config|control|worker|match)$/.test(r.source)
                ? `src src-${r.source}`
                : "src src-default";
            const tsDisplay = r.ts && r.ts.includes("T")
              ? (() => { const d = new Date(r.ts); const p = (n: number) => String(n).padStart(2,"0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })()
              : r.ts;
            return (
              <div key={r.id} className={`log-line log-${r.level}`}>
                <span className="log-time">[{tsDisplay}]</span>{" "}
                <span className={`lvl-${r.level} font-bold`}>{r.level}</span>{" "}
                {r.source && <span className={srcCls}>{r.source}</span>}{" "}
                <span>{r.message}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function ChevronIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function TrashIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-2 6h10l-1 12H8L7 9z" />
    </svg>
  );
}
