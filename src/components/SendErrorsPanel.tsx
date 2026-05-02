import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type SendErrorEntry = {
  org_label: string;
  error_count: number;
  last_status: number | null;
  last_error_code: number | null;
  last_message: string | null;
  last_seen: string;
};

function describeCode(code: number | null, message: string | null): string {
  if (code === 200000) return "AutoMod bloqueou a mensagem";
  if (code === 50013) {
    const lower = (message ?? "").toLowerCase();
    if (lower.includes("timed out") || lower.includes("communication")) {
      return "Token em timeout/silenciado";
    }
    return "Sem permissão SEND_MESSAGES";
  }
  if (code === 50001) return "Sem acesso ao canal";
  if (code === 50007) return "DM bloqueada pelo usuário";
  if (code === 40005) return "Mensagem grande demais";
  if (code === 10003) return "Canal não existe";
  if (code) return `Discord code ${code}`;
  return message ?? "—";
}

export function SendErrorsPanel({ instanceId }: { instanceId: number }) {
  const [rows, setRows] = useState<SendErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<SendErrorEntry[]>(`/api/instances/${instanceId}/send-errors`);
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    reload().catch(console.error);
  }, [reload]);

  async function clearOne(orgLabel: string) {
    setBusy(true);
    try {
      await api(
        `/api/instances/${instanceId}/send-errors?org_label=${encodeURIComponent(orgLabel)}`,
        { method: "DELETE" },
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    try {
      await api(`/api/instances/${instanceId}/send-errors`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const total = rows.length;
  const totalErrors = rows.reduce((s, r) => s + r.error_count, 0);

  return (
    <div className="rounded-2xl bg-navy-900 border border-white/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors"
      >
        <AlertIcon className="w-5 h-5 text-amber-400 shrink-0" />
        <span className="text-lg font-bold flex-1">
          Erros de envio de mensagem por org
        </span>
        {totalErrors > 0 && (
          <span className="text-xs font-semibold bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/30 rounded-full px-2.5 py-0.5">
            {totalErrors} erro{totalErrors !== 1 ? "s" : ""} · {total} org{total !== 1 ? "s" : ""}
          </span>
        )}
        <ChevronIcon className={`w-4 h-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3 border-t border-white/10 pt-4">
          {loading && (
            <p className="text-sm text-slate-500">Carregando…</p>
          )}

          {!loading && total === 0 && (
            <p className="text-sm text-slate-500">Nenhum erro de envio registrado.</p>
          )}

          {!loading && total > 0 && (
            <div className="rounded-xl border border-white/10 bg-navy-950/60 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-slate-400 uppercase tracking-wide">
                    <th className="text-left px-4 py-2 font-medium">Org</th>
                    <th className="text-center px-4 py-2 font-medium w-16">Erros</th>
                    <th className="text-center px-4 py-2 font-medium w-16">HTTP</th>
                    <th className="text-left px-4 py-2 font-medium">Causa</th>
                    <th className="text-right px-4 py-2 font-medium w-24">Último</th>
                    <th className="w-10 px-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map((r) => (
                    <tr key={r.org_label} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-2.5 font-medium text-slate-200 capitalize truncate max-w-[180px]">
                        {r.org_label}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/30">
                          {r.error_count}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {r.last_status ? (
                          <span className="text-xs font-mono text-rose-300">{r.last_status}</span>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-300" title={r.last_message ?? undefined}>
                        <div className="flex items-center gap-1.5">
                          {r.last_error_code !== null && (
                            <span className="font-mono text-[10px] text-slate-500">#{r.last_error_code}</span>
                          )}
                          <span className="truncate max-w-[260px]">
                            {describeCode(r.last_error_code, r.last_message)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-slate-500">
                        {new Date(r.last_seen).toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => clearOne(r.org_label)}
                          className="text-xs text-slate-500 hover:text-white disabled:opacity-40 transition-colors"
                          title="Limpar erros desta org"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && total > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={clearAll}
              className="btn-danger disabled:opacity-50 w-full justify-center"
            >
              <TrashIcon className="w-4 h-4" />
              {busy ? "Limpando…" : "Limpar todos os erros desta instância"}
            </button>
          )}

          <p className="text-xs text-slate-500">
            Conta apenas erros de envio de mensagem na partida (não erros de fila).
            Só vai pra blacklist por token quando for permissão real
            (codes 50013/50001 sem timeout). AutoMod e timeout aparecem aqui e
            o bot continua tentando.
          </p>
        </div>
      )}
    </div>
  );
}

function AlertIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  );
}

function ChevronIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function TrashIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}
