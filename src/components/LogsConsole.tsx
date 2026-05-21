import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

const DISPLAY_LIMIT = 100;
const BUFFER_LIMIT = 5000;
const POLL_MS = 3000;
const INITIAL_FETCH = 500;
const POLL_FETCH = 200;

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
  const lastIdRef = useRef<number | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setRows([]);
    lastIdRef.current = null;

    async function init() {
      try {
        const r = await api<LogRow[]>(`/api/logs/${instanceId}?limit=${INITIAL_FETCH}`);
        if (!active) return;
        const sorted = [...r].sort((a, b) => b.id - a.id);
        const maxId = sorted.length > 0 ? sorted[0]!.id : 0;
        setRows(sorted);
        lastIdRef.current = maxId;
      } catch {
        lastIdRef.current = 0;
      }
    }

    async function pollNew() {
      if (lastIdRef.current === null) return;
      const afterId = lastIdRef.current;
      try {
        const r = await api<LogRow[]>(
          `/api/logs/${instanceId}?after_id=${afterId}&limit=${POLL_FETCH}`,
        );
        if (!active || r.length === 0) return;
        const sorted = [...r].sort((a, b) => b.id - a.id);
        const maxId = sorted[0]!.id;
        if (maxId > lastIdRef.current!) lastIdRef.current = maxId;
        setRows((prev) => {
          const combined = [...sorted, ...prev];
          return combined.length > BUFFER_LIMIT ? combined.slice(0, BUFFER_LIMIT) : combined;
        });
      } catch { /* noop */ }
    }

    init();
    const timer = setInterval(pollNew, POLL_MS);
    return () => { active = false; clearInterval(timer); };
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
      triggerDownload(`/api/logs/${instanceId}/export?minutes=${minutes}`, `logs-${label}-inst${instanceId}.txt`);
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
    } catch { /* noop */ }
  }

  const display = rows.slice(0, DISPLAY_LIMIT);
  const loading = lastIdRef.current === null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-sm font-semibold text-slate-200">Logs</span>
          <span className="text-[11px] text-slate-600">
            {loading ? "carregando…" : `${rows.length > DISPLAY_LIMIT ? `${DISPLAY_LIMIT}/${rows.length}` : rows.length}`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className={
              "btn-ghost text-xs px-2.5 py-1.5 gap-1 " +
              (copying ? "text-emerald-400 ring-emerald-500/30" : "")
            }
          >
            {copying ? <><CheckIcon className="w-3 h-3" /> Copiado</> : <><CopyIcon className="w-3 h-3" /> Copiar</>}
          </button>

          <div className="relative" ref={exportRef}>
            <button
              type="button"
              onClick={() => setExportOpen((o) => !o)}
              className="btn-ghost text-xs px-2.5 py-1.5 gap-1"
            >
              <DownloadIcon className="w-3 h-3" /> Exportar
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-xl border border-white/[0.08] bg-navy-900 shadow-xl overflow-hidden">
                <div className="px-3 py-1.5 text-[9px] text-slate-600 uppercase tracking-wider border-b border-white/[0.05]">
                  Exportar .txt
                </div>
                {(
                  [
                    { label: "Últimos 10 min", value: 10 },
                    { label: "Últimos 30 min", value: 30 },
                    { label: "Últimos 60 min", value: 60 },
                    { label: "Todos", value: "all" },
                    { label: "Sessão atual", value: "session" },
                  ] as { label: string; value: ExportWindow }[]
                ).map((opt) => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => handleExport(opt.value)}
                    className="w-full text-left px-3 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
                  >
                    {opt.label}
                    {opt.value === "session" && (
                      <span className="ml-2 text-[10px] text-slate-600">{rows.length}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button type="button" onClick={clear} className="btn-ghost text-xs px-2.5 py-1.5 gap-1">
            <TrashIcon className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Log output */}
      <div className="rounded-xl bg-black/40 border border-white/[0.05] p-3 h-[240px] sm:h-[280px] overflow-auto">
        {loading && <div className="text-slate-600 text-xs">Carregando…</div>}
        {!loading && display.length === 0 && (
          <div className="text-slate-600 text-xs">Sem logs ainda.</div>
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
              <span className={`lvl-${r.level} font-semibold`}>{r.level}</span>{" "}
              {r.source && <span className={srcCls}>{r.source}</span>}{" "}
              <span>{r.message}</span>
            </div>
          );
        })}
      </div>

      {rows.length > DISPLAY_LIMIT && (
        <p className="text-[10px] text-slate-700 mt-1.5 text-right">
          Exibindo {DISPLAY_LIMIT} de {rows.length}. Use Exportar para todos.
        </p>
      )}
    </div>
  );
}

function TerminalIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>);
}
function TrashIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-2 6h10l-1 12H8L7 9z" /></svg>);
}
function CopyIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>);
}
function CheckIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>);
}
function DownloadIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v13m0 0l-4-4m4 4l4-4M3 20h18" /></svg>);
}
