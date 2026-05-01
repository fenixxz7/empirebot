import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type BlacklistEntry = {
  token_id: number;
  token_position: number;
  org_id: number;
  org_name: string;
  reason: string | null;
  blocked_at: string;
};

type GroupedByToken = {
  token_id: number;
  token_position: number;
  orgs: Omit<BlacklistEntry, "token_id" | "token_position">[];
};

function groupByToken(rows: BlacklistEntry[]): GroupedByToken[] {
  const map = new Map<number, GroupedByToken>();
  for (const r of rows) {
    if (!map.has(r.token_id)) {
      map.set(r.token_id, {
        token_id: r.token_id,
        token_position: r.token_position,
        orgs: [],
      });
    }
    map.get(r.token_id)!.orgs.push({
      org_id: r.org_id,
      org_name: r.org_name,
      reason: r.reason,
      blocked_at: r.blocked_at,
    });
  }
  return [...map.values()].sort((a, b) => a.token_position - b.token_position);
}

export function BlacklistPanel({ instanceId }: { instanceId: number }) {
  const [rows, setRows] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<BlacklistEntry[]>(`/api/instances/${instanceId}/blacklist`);
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    reload().catch(console.error);
  }, [reload]);

  async function removeOne(tokenId: number, orgId: number) {
    setBusy(true);
    try {
      await api(`/api/instances/${instanceId}/blacklist/${tokenId}/${orgId}`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function clearToken(tokenId: number) {
    setBusy(true);
    try {
      await api(`/api/instances/${instanceId}/blacklist?token_id=${tokenId}`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    try {
      await api(`/api/instances/${instanceId}/blacklist`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const groups = groupByToken(rows);
  const total = rows.length;

  return (
    <div className="rounded-2xl bg-navy-900 border border-white/10 overflow-hidden">
      {/* Header toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors"
      >
        <ShieldIcon className="w-5 h-5 text-rose-400 shrink-0" />
        <span className="text-lg font-bold flex-1">
          Blacklist de orgs por token
        </span>
        {total > 0 && (
          <span className="text-xs font-semibold bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/30 rounded-full px-2.5 py-0.5">
            {total} bloqueada{total !== 1 ? "s" : ""}
          </span>
        )}
        <ChevronIcon className={`w-4 h-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-white/10 pt-4">
          {loading && (
            <p className="text-sm text-slate-500">Carregando…</p>
          )}

          {!loading && total === 0 && (
            <p className="text-sm text-slate-500">Nenhuma org bloqueada no momento.</p>
          )}

          {!loading && groups.map((g) => (
            <div key={g.token_id} className="rounded-xl border border-white/10 bg-navy-950/60 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
                <span className="text-sm font-semibold text-slate-200">
                  Token #{g.token_position}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => clearToken(g.token_id)}
                  className="text-xs text-rose-300 hover:text-rose-200 disabled:opacity-50 transition-colors"
                >
                  Limpar token
                </button>
              </div>
              <ul className="divide-y divide-white/5">
                {g.orgs.map((o) => (
                  <li key={o.org_id} className="flex items-start gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-slate-200 capitalize">{o.org_name}</span>
                      {o.reason && (
                        <p className="text-xs text-slate-500 truncate mt-0.5">{o.reason}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeOne(g.token_id, o.org_id)}
                      className="text-xs text-slate-400 hover:text-white disabled:opacity-40 transition-colors mt-0.5 shrink-0"
                      title="Desbloquear"
                    >
                      ✕ desbloquear
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {!loading && total > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={clearAll}
              className="btn-danger disabled:opacity-50 w-full justify-center"
            >
              <TrashIcon className="w-4 h-4" />
              {busy ? "Limpando…" : "Limpar toda a blacklist desta instância"}
            </button>
          )}

          <p className="text-xs text-slate-500">
            Orgs bloqueadas são ignoradas pelo engine para aquele token.
            Ao desbloquear, o bot volta a tentar entrar nas filas dessa org.
          </p>
        </div>
      )}
    </div>
  );
}

function ShieldIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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
