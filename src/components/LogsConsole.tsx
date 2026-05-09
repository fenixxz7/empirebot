import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

const DISPLAY_LIMIT = 100;
const BUFFER_LIMIT = 5000;
const POLL_MS = 3000;
const INITIAL_FETCH = 500;

type LogRow = {
  id: number;
  ts: string;
  level: "INFO" | "WARN" | "ERROR";
  source: string | null;
  message: string;
};

type ExportWindow = 10 | 30 | 60 | "all" | "session";

export function LogsConsole({ instanceId }: { instanceId: number }) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const lastIdRef = useRef(0);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setRows([]);
    lastIdRef.current = 0;

    async function init() {
      try {
        const r = await api<LogRow[]>(`/api/logs/${instanceId}?limit=${INITIAL_FETCH}`);
        if (!active) return;
        setRows(r);
        if (r.length > 0) lastIdRef.current = r[0]!.id;
      } catch (e) {
        console.error(e);
      }
    }

    async function pollNew() {
      if (lastIdRef.current === 0) return;
      try {
        const r = await api<LogRow[]>(
          `/api/logs/${instanceId}?after_id=${lastIdRef.current}&limit=200`,
        );
        if (!active || r.length === 0) return;
        if (r[0]!.id > lastIdRef.current) lastIdRef.current = r[0]!.id;
        setRows((prev) => {
          const combined = [...r, ...prev];
          return combined.length > BUFFER_LIMIT ? combined.slice(0, BUFFER_LIMIT) : combined;
        });
      } catch (e) {
        console.error(e);
      }
    }

    init();
    const timer = setInterval(pollNew, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [instanceId]);

  useEffect(() => {
    if (!exportOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [exportOpen]);

  async function clear() {
    await api(`/api/logs/${instanceId}`, { method: "DELETE" });
    setRows([]);
    lastIdRef.current = 0;
  }

  function formatRowText(r: LogRow): string {
    const d = new Date(r.ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    const datePart = isNaN(d.getTime())
      ? r.ts
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return `[${datePart}] ${r.level.padEnd(5)} ${(r.source ?? "").padEnd(12)} ${r.message}`;
  }

  function buildSessionText(): string {
    return [...rows].reverse().map(formatRowText).join("\n");
  }

  async function handleExport(window: ExportWindow) {
    if (window === "session") {
      const text = buildSessionText();
      const blob = new Blob([text], { type: "text/plain; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `logs-sessao-${instanceId}.txt`);
      URL.revokeObjectURL(url);
    } else {
      const minutes = window === "all" ? "all" : window;
      const label = window === "all" ? "todos" : `${window}min`;
      triggerDownload(
        `/api/logs/${instanceId}/export?minutes=${minutes}`,
        `logs-${label}-inst${instanceId}.txt`,
      );
    }
    setExportOpen(false);
  }

  function triggerDownload(href: string, filename: string) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildSessionText());
      setCopying(true);
      setTimeout(() => setCopying(false), 2000);
    } catch {
      console.error("clipboard error");
    }
  }

  const display = rows.slice(0, DISPLAY_LIMIT);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-bold flex items-center gap-2">
          <ChevronIcon className="w-4 h-4 text-emerald-300" />
          Logs{" "}
          <span className="text-slate-500 font-normal">
            ({rows.length > DISPLAY_LIMIT ? `exibindo ${DISPLAY_LIMIT} de ${rows.length}` : rows.length})
          </span>
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleCopy}
            className={
              "btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5 transition-colors " +
              (copying ? "text-emerald-400 border-emerald-500/40" : "")
            }
          >
            {copying ? (
              <>
                <CheckIcon className="w-3.5 h-3.5" /> Copiado!
              </>
            ) : (
              <>
                <CopyIcon className="w-3.5 h-3.5" /> Copiar
              </>
            )}
          </button>

          <div className="relative" ref={exportRef}>
            <button
              type="button"
              onClick={() => setExportOpen((o) => !o)}
              className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
            >
              <DownloadIcon className="w-3.5 h-3.5" /> Exportar
              <ChevronDownIcon className="w-3 h-3 opacity-60" />
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[190px] rounded-xl border border-white/10 bg-navy-900 shadow-xl overflow-hidden">
                <div className="px-3 py-1.5 text-[10px] text-slate-500 uppercase tracking-wider border-b border-white/5">
                  Exportar como .txt
                </div>
                {(
                  [
                    { label: "Últimos 10 minutos", value: 10 },
                    { label: "Últimos 30 minutos", value: 30 },
                    { label: "Últimos 60 minutos", value: 60 },
                    { label: "Todos (desde o início)", value: "all" },
                    { label: "Sessão atual (buffer)", value: "session" },
                  ] as { label: string; value: ExportWindow }[]
                ).map((opt) => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => handleExport(opt.value)}
                    className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 transition-colors flex items-center gap-2"
                  >
                    {opt.value === "session" ? (
                      <span className="text-accent">●</span>
                    ) : (
                      <DownloadIcon className="w-3 h-3 opacity-40" />
                    )}
                    {opt.label}
                    {opt.value === "session" && (
                      <span className="ml-auto text-[10px] text-slate-500">{rows.length} logs</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={clear}
            className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
          >
            <TrashIcon className="w-3.5 h-3.5" /> Limpar
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-black/60 border border-white/10 p-3 h-[260px] overflow-auto">
        {display.length === 0 && (
          <div className="text-slate-500 text-sm">Sem logs ainda.</div>
        )}
        {display.map((r) => {
          const t = new Date(r.ts);
          const hh = String(t.getHours()).padStart(2, "0");
          const mm = String(t.getMinutes()).padStart(2, "0");
          const ss = String(t.getSeconds()).padStart(2, "0");
          const srcCls =
            r.source &&
            /^(gateway|engine|discovery|config|control|worker|match)$/.test(r.source)
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

      {rows.length > DISPLAY_LIMIT && (
        <p className="text-[10px] text-slate-600 mt-1.5 text-right">
          Exibindo os {DISPLAY_LIMIT} logs mais recentes. Use "Exportar" para ver todos os {rows.length}.
        </p>
      )}
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
function ChevronDownIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
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
function CopyIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}
function CheckIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function DownloadIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3v13m0 0l-4-4m4 4l4-4M3 20h18" />
    </svg>
  );
}
