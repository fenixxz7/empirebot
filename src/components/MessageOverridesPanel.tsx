import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type OverrideEntry = {
  org_key: string;
  message: string;
  source: "auto" | "manual" | "pending";
  automod_blocks: number;
  generated_at: string;
};

export function MessageOverridesPanel({ instanceId }: { instanceId: number }) {
  const [rows, setRows] = useState<OverrideEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<OverrideEntry[]>(
        `/api/instances/${instanceId}/message-overrides`,
      );
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    reload().catch(console.error);
  }, [reload]);

  async function clearOne(orgKey: string) {
    setBusy(true);
    try {
      await api(
        `/api/instances/${instanceId}/message-overrides?org_key=${encodeURIComponent(orgKey)}`,
        { method: "DELETE" },
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(orgKey: string) {
    setBusy(true);
    try {
      await api(`/api/instances/${instanceId}/message-overrides`, {
        method: "PUT",
        body: JSON.stringify({ org_key: orgKey, message: draft }),
      });
      setEditing(null);
      setDraft("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // Mostra apenas overrides com mensagem definida (oculta os "pending"
  // que ainda nem geraram alternativa).
  const visible = rows.filter((r) => r.source !== "pending" && r.message.trim());
  const total = visible.length;
  const autoCount = visible.filter((r) => r.source === "auto").length;

  return (
    <div className="rounded-2xl bg-navy-900 border border-white/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-white/5 transition-colors"
      >
        <ShieldIcon className="w-5 h-5 text-emerald-400 shrink-0" />
        <span className="text-lg font-bold flex-1">
          Mensagens alternativas por org (anti-AutoMod)
        </span>
        {total > 0 && (
          <span className="text-xs font-semibold bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/30 rounded-full px-2.5 py-0.5">
            {total} org{total !== 1 ? "s" : ""}
            {autoCount > 0 && ` · ${autoCount} auto`}
          </span>
        )}
        <ChevronIcon
          className={`w-4 h-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3 border-t border-white/10 pt-4">
          {loading && <p className="text-sm text-slate-500">Carregando…</p>}

          {!loading && total === 0 && (
            <p className="text-sm text-slate-500">
              Nenhuma mensagem alternativa ativa. Quando o AutoMod bloquear 3×
              numa mesma org, o sistema gera automaticamente uma versão limpa
              que mantém a menção do adversário.
            </p>
          )}

          {!loading && total > 0 && (
            <div className="space-y-2">
              {visible.map((r) => (
                <div
                  key={r.org_key}
                  className="rounded-xl border border-white/10 bg-navy-950/60 p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-200 capitalize truncate flex-1">
                      {r.org_key}
                    </span>
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ring-1 ${
                        r.source === "auto"
                          ? "bg-amber-500/20 text-amber-300 ring-amber-400/30"
                          : "bg-sky-500/20 text-sky-300 ring-sky-400/30"
                      }`}
                    >
                      {r.source === "auto" ? "auto-gerada" : "manual"}
                    </span>
                    {r.automod_blocks > 0 && (
                      <span
                        className="text-[10px] text-slate-500"
                        title={`Bloqueios AutoMod nessa org`}
                      >
                        {r.automod_blocks} bloqueio
                        {r.automod_blocks !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>

                  {editing === r.org_key ? (
                    <div className="space-y-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={2}
                        className="w-full bg-navy-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                        placeholder="{adversary_mention} chama no privado"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy || !draft.trim()}
                          onClick={() => saveEdit(r.org_key)}
                          className="btn-primary text-xs disabled:opacity-50"
                        >
                          Salvar
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditing(null);
                            setDraft("");
                          }}
                          className="btn-secondary text-xs disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-300 font-mono bg-navy-900/60 rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
                      {r.message}
                    </p>
                  )}

                  {editing !== r.org_key && (
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-600">
                        Atualizado{" "}
                        {new Date(r.generated_at).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditing(r.org_key);
                            setDraft(r.message);
                          }}
                          className="text-slate-400 hover:text-white transition-colors disabled:opacity-40"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => clearOne(r.org_key)}
                          className="text-rose-400 hover:text-rose-300 transition-colors disabled:opacity-40"
                          title="Remover override (volta a usar a mensagem global)"
                        >
                          Remover
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-slate-500 leading-relaxed">
            Override por org tem precedência sobre a mensagem global. Auto-geradas
            são acionadas após 3 bloqueios de AutoMod na mesma org — o sistema
            limpa símbolos de moeda, repetições e ruído mas mantém a menção do
            adversário e o pedido de DM/privado. Você pode editar ou remover
            qualquer uma a qualquer momento.
          </p>
        </div>
      )}
    </div>
  );
}

function ShieldIcon({ className = "" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
    </svg>
  );
}

function ChevronIcon({ className = "" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
