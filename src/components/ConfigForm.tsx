import { useEffect, useMemo, useRef, useState } from "react";
import type { Org, OrgChannel } from "@shared/types";
import { api } from "@/lib/api";

type Category = "Mobile" | "Misto" | "Emulador" | "Tatico" | "Full-Soco";

const ALL_CATEGORIES: Category[] = [
  "Mobile",
  "Misto",
  "Emulador",
  "Tatico",
  "Full-Soco",
];

type ConfigPayload = {
  config: {
    category: Category;
    allowed_categories: string;
    delay_seconds: number;
    rotation_minutes: number;
    allowed_modes: string;
    message_main: string;
    message_per_org: string;
    image_url: string | null;
  } | null;
  tokens: { id: number; position: number; value_preview: string; status: string; username: string | null }[];
  selected_org_ids: number[];
};

function parseCats(raw: string): Category[] {
  const set = new Set<Category>();
  for (const piece of raw.split(/[\s,;\n]+/)) {
    const t = piece.trim();
    if (ALL_CATEGORIES.includes(t as Category)) {
      set.add(t as Category);
    }
  }
  return ALL_CATEGORIES.filter((c) => set.has(c));
}

export function ConfigForm({
  instanceId,
  running,
  onSaved,
}: {
  instanceId: number;
  running: boolean;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [data, setData] = useState<ConfigPayload | null>(null);
  const [tokensRaw, setTokensRaw] = useState("");
  const [allowedCats, setAllowedCats] = useState<Set<Category>>(
    new Set<Category>(["Mobile"]),
  );
  const [delay, setDelay] = useState(12);
  const [rotation, setRotation] = useState(90);
  const [allowedModes, setAllowedModes] = useState("1x1\n3x3");
  const [messageMain, setMessageMain] = useState("");
  const [messagePerOrg, setMessagePerOrg] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<number>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openOrgId, setOpenOrgId] = useState<number | null>(null);
  const [orgsMode, setOrgsMode] = useState<"normal" | "delete" | "add">("normal");
  const [deleteSet, setDeleteSet] = useState<Set<number>>(new Set());
  const [busyOrgs, setBusyOrgs] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgGuild, setNewOrgGuild] = useState("");
  const [newOrgCategory, setNewOrgCategory] = useState<Category>("Mobile");
  const importRef = useRef<HTMLInputElement>(null);

  async function reload() {
    setLoading(true);
    const cfg = await api<ConfigPayload>(`/api/config/${instanceId}`);
    setData(cfg);
    if (cfg.config) {
      const fromAllowed = parseCats(cfg.config.allowed_categories ?? "");
      const initial = fromAllowed.length > 0
        ? fromAllowed
        : ([cfg.config.category as Category].filter((c) =>
            ALL_CATEGORIES.includes(c),
          ) as Category[]);
      setAllowedCats(new Set(initial.length > 0 ? initial : ["Mobile"]));
      setDelay(cfg.config.delay_seconds);
      setRotation(cfg.config.rotation_minutes);
      setAllowedModes(cfg.config.allowed_modes);
      setMessageMain(cfg.config.message_main);
      setMessagePerOrg(cfg.config.message_per_org);
      setImageUrl(cfg.config.image_url ?? "");
    }
    setSelectedOrgIds(new Set(cfg.selected_org_ids));
    setLoading(false);
  }

  useEffect(() => {
    reload().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  async function reloadOrgs() {
    // Listamos todas as orgs cadastradas, sem filtrar por categoria — a
    // categoria por canal é o que controla onde o bot entra.
    const rows = await api<Org[]>(`/api/orgs`);
    setOrgs(rows);
  }

  useEffect(() => {
    reloadOrgs().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleCat(c: Category) {
    setAllowedCats((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c); else n.add(c);
      return n;
    });
  }

  function cancelOrgsAction() {
    setOrgsMode("normal");
    setDeleteSet(new Set());
    setNewOrgName("");
    setNewOrgGuild("");
  }

  function toggleDelete(id: number) {
    setDeleteSet((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function confirmDelete() {
    if (deleteSet.size === 0) {
      cancelOrgsAction();
      return;
    }
    setBusyOrgs(true);
    setFeedback(null);
    try {
      for (const id of deleteSet) {
        await api(`/api/orgs/${id}`, { method: "DELETE" });
      }
      setSelectedOrgIds((prev) => {
        const n = new Set(prev);
        for (const id of deleteSet) n.delete(id);
        return n;
      });
      const n = deleteSet.size;
      cancelOrgsAction();
      await reloadOrgs();
      setFeedback(`${n} org(s) apagada(s).`);
      setTimeout(() => setFeedback(null), 3000);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Erro ao apagar org");
    } finally {
      setBusyOrgs(false);
    }
  }

  async function confirmAdd() {
    const name = newOrgName.trim();
    if (!name) {
      setFeedback("Informe o nome da org.");
      return;
    }
    setBusyOrgs(true);
    setFeedback(null);
    try {
      await api(`/api/orgs`, {
        method: "POST",
        body: JSON.stringify({
          name,
          category: newOrgCategory,
          guild_id: newOrgGuild.trim() || null,
        }),
      });
      cancelOrgsAction();
      await reloadOrgs();
      setFeedback(`Org "${name}" adicionada.`);
      setTimeout(() => setFeedback(null), 3000);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Erro ao adicionar org");
    } finally {
      setBusyOrgs(false);
    }
  }

  const tokensCount = data?.tokens.length ?? 0;
  const tokensActive = useMemo(
    () => (data?.tokens ?? []).filter((t) => t.status === "connected").length,
    [data]
  );

  function toggleOrg(id: number) {
    setSelectedOrgIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function save() {
    setSaving(true);
    setFeedback("Salvando e descobrindo canais novos…");
    try {
      const cats = ALL_CATEGORIES.filter((c) => allowedCats.has(c));
      if (cats.length === 0) {
        setFeedback("Selecione ao menos uma categoria.");
        setSaving(false);
        return;
      }
      const r = await api<{
        ok: boolean;
        discovery: {
          ok: boolean;
          channels_found?: number;
          queues_saved?: number;
        }[];
        discovery_skipped: string | null;
      }>(`/api/config/${instanceId}`, {
        method: "PUT",
        body: JSON.stringify({
          allowed_categories: cats,
          delay_seconds: Number(delay),
          rotation_minutes: Number(rotation),
          allowed_modes: allowedModes,
          message_main: messageMain,
          message_per_org: messagePerOrg,
          image_url: imageUrl.trim() || null,
          tokens_raw: tokensRaw,
          selected_org_ids: Array.from(selectedOrgIds),
        }),
      });
      setTokensRaw("");
      await reload();
      await reloadOrgs();
      const orgsScanned = r.discovery?.length ?? 0;
      const totalCh = (r.discovery ?? []).reduce(
        (s, x) => s + (x.channels_found ?? 0),
        0,
      );
      const totalQ = (r.discovery ?? []).reduce(
        (s, x) => s + (x.queues_saved ?? 0),
        0,
      );
      let msg = "Configuração salva com sucesso.";
      if (r.discovery_skipped) {
        msg += ` (${r.discovery_skipped})`;
      } else if (orgsScanned > 0) {
        msg += ` Descoberta automática: ${totalCh} ${totalCh === 1 ? "canal" : "canais"} em ${orgsScanned} org(s), ${totalQ} fila(s).`;
      }
      setFeedback(msg);
      onSaved();
      setTimeout(() => setFeedback(null), 5000);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  async function exportConfig() {
    const res = await fetch(`/api/config/${instanceId}/export`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `imperiuns-config-${instanceId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await api(`/api/config/${instanceId}/import`, {
        method: "POST",
        body: JSON.stringify(json),
      });
      await reload();
      await reloadOrgs();
      setFeedback("Configuração importada com sucesso.");
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Erro ao importar");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }

  if (loading) {
    return (
      <div className="card p-6 text-slate-400 text-sm">Carregando configuração…</div>
    );
  }

  return (
    <div className="card p-6 space-y-6">
      <div className="flex items-center gap-2">
        <SettingsIcon className="w-5 h-5 text-accent" />
        <h2 className="text-lg font-bold">Configuração</h2>
      </div>

      <Section title="Tokens Discord (até 5, 1 por linha)">
        <textarea
          className="textarea"
          placeholder={
            tokensCount > 0
              ? `Já existem ${tokensCount} token(s) salvos. Cole novos para substituir, ou deixe vazio para manter.`
              : "token_1\ntoken_2\ntoken_3"
          }
          value={tokensRaw}
          onChange={(e) => setTokensRaw(e.target.value)}
        />
        <p className="text-xs text-slate-500 mt-2">
          Rotação automática em ciclo. Se vazio, mantém tokens já salvos no servidor.
        </p>
        {(data?.tokens?.length ?? 0) > 0 && (
          <ul className="mt-3 space-y-1.5">
            {data!.tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 text-xs bg-navy-950/60 border border-white/10 rounded-lg px-3 py-2"
              >
                <span className="text-slate-500 w-10">#{t.position}</span>
                <span className="font-mono text-slate-300 flex-1 truncate">
                  {t.value_preview}
                </span>
                {t.username && (
                  <span className="text-slate-200 truncate max-w-[160px]">
                    {t.username}
                  </span>
                )}
                <TokenStatus status={t.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid sm:grid-cols-2 gap-4">
        <Section title="Rotação de token (minutos)">
          <input
            type="number" min={1} className="input"
            value={rotation} onChange={(e) => setRotation(Number(e.target.value))}
          />
          <p className="text-xs text-slate-500 mt-2">
            Tokens ativos: <b className="text-slate-300">{tokensActive}/{tokensCount}</b>
          </p>
        </Section>
        <Section title="Delay (segundos)">
          <input
            type="number" min={1} className="input"
            value={delay} onChange={(e) => setDelay(Number(e.target.value))}
          />
        </Section>
      </div>

      <Section title="Categorias permitidas">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {ALL_CATEGORIES.map((c) => {
            const on = allowedCats.has(c);
            return (
              <button
                type="button"
                key={c}
                onClick={() => toggleCat(c)}
                className={
                  "flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors " +
                  (on
                    ? "bg-accent/15 border-accent/50 text-accent"
                    : "bg-navy-950/60 border-white/10 text-slate-300 hover:border-white/30")
                }
              >
                <span
                  className={
                    "w-4 h-4 rounded-md border flex items-center justify-center " +
                    (on
                      ? "bg-accent border-accent text-navy-950"
                      : "border-white/30 text-transparent")
                  }
                >
                  <CheckIcon className="w-3 h-3" />
                </span>
                {c}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          O bot só entrará em canais cujo sufixo do nome combine com uma das
          categorias marcadas (ex: <code>-mob</code>, <code>-emu</code>,{" "}
          <code>-misto</code>, <code>-tatico</code>, <code>full-soco</code>).
        </p>
      </Section>

      <Section title="Selecionar orgs">
        <div className="rounded-xl bg-navy-950/60 border border-white/10 p-3 space-y-1.5">
          {orgs.length === 0 && (
            <div className="text-sm text-slate-500">Nenhuma org cadastrada.</div>
          )}
          {orgs.map((o) => (
            <OrgRow
              key={o.id}
              org={o}
              mode={orgsMode === "delete" ? "delete" : "normal"}
              checked={selectedOrgIds.has(o.id)}
              markedForDelete={deleteSet.has(o.id)}
              onToggle={() => toggleOrg(o.id)}
              onToggleDelete={() => toggleDelete(o.id)}
              onShowChannels={() => setOpenOrgId(o.id === openOrgId ? null : o.id)}
              expanded={o.id === openOrgId}
            />
          ))}
        </div>

        {orgsMode === "normal" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOrgsMode("add")}
              className="btn-secondary"
            >
              <PlusIcon className="w-4 h-4" />
              Adicionar org
            </button>
            <button
              type="button"
              onClick={() => setOrgsMode("delete")}
              disabled={orgs.length === 0}
              className="btn-secondary text-rose-300 ring-rose-400/30 hover:ring-rose-400/60 disabled:opacity-40"
            >
              <TrashIcon className="w-4 h-4" />
              Apagar org
            </button>
            <span className="text-xs text-slate-500 ml-1">
              Os canais são descobertos automaticamente ao salvar.
            </span>
          </div>
        )}

        {orgsMode === "delete" && (
          <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/5 p-3">
            <div className="text-xs text-rose-200/90 mb-2">
              Marque as orgs que deseja apagar e confirme. Esta ação remove
              também os canais e botões já descobertos delas.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busyOrgs || deleteSet.size === 0}
                className="btn-danger disabled:opacity-50"
              >
                <TrashIcon className="w-4 h-4" />
                {busyOrgs ? "Apagando…" : `Confirmar (${deleteSet.size})`}
              </button>
              <button
                type="button"
                onClick={cancelOrgsAction}
                disabled={busyOrgs}
                className="btn-secondary disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {orgsMode === "add" && (
          <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
            <div className="text-xs text-slate-400">
              Adicionar nova org. A categoria abaixo é apenas metadado — o bot
              filtra os canais pelo sufixo do nome.
            </div>
            <div className="grid sm:grid-cols-3 gap-2">
              <input
                className="input sm:col-span-1"
                placeholder="Nome da org (ex: Surf)"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                autoFocus
              />
              <input
                className="input font-mono text-xs sm:col-span-1"
                placeholder="guild_id (opcional)"
                value={newOrgGuild}
                onChange={(e) => setNewOrgGuild(e.target.value)}
              />
              <select
                className="input sm:col-span-1"
                value={newOrgCategory}
                onChange={(e) => setNewOrgCategory(e.target.value as Category)}
              >
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={confirmAdd}
                disabled={busyOrgs || !newOrgName.trim()}
                className="btn-primary disabled:opacity-50"
              >
                <PlusIcon className="w-4 h-4" />
                {busyOrgs ? "Adicionando…" : "Confirmar"}
              </button>
              <button
                type="button"
                onClick={cancelOrgsAction}
                disabled={busyOrgs}
                className="btn-secondary disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Modos de fila permitidos">
        <textarea
          className="textarea min-h-[90px]"
          placeholder={"1x1\n3x3"}
          value={allowedModes}
          onChange={(e) => setAllowedModes(e.target.value)}
        />
        <p className="text-xs text-slate-500 mt-2">
          Aceita 1x1, 2x2, 3x3, 4x4 e variações como 1v1, x2, x3, x4.
        </p>
      </Section>

      <Section title="Mensagem dentro da partida">
        <input
          className="input"
          value={messageMain}
          onChange={(e) => setMessageMain(e.target.value)}
        />
        <p className="text-xs text-slate-500 mt-2">
          Variáveis: <code className="text-slate-300">{"{adversary_mention}"}</code>,{" "}
          <code className="text-slate-300">{"{adversary_id}"}</code>,{" "}
          <code className="text-slate-300">{"{channel_name}"}</code>.
        </p>
      </Section>

      <Section title="Mensagem secundária por org">
        <textarea
          className="textarea"
          placeholder={"Exemplo:\nHelipa | teste\nMoreira F1 | oi {adversary_mention}\n\nOu em pares de linha:\nNome da Org\noi {adversary_mention}"}
          value={messagePerOrg}
          onChange={(e) => setMessagePerOrg(e.target.value)}
        />
        <p className="text-xs text-slate-500 mt-2">
          Prioridade por org. Aceita nome da org ou guild_id.
        </p>
      </Section>

      <Section title="Imagem na mensagem (URL)">
        <input
          className="input"
          type="url"
          placeholder="https://… (deixe vazio para enviar só texto)"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
        />
        <p className="text-xs text-slate-500 mt-2">
          Cole a URL pública de uma imagem (PNG/JPG/GIF). Ela vai junto com a
          mensagem dentro da partida, em todas as orgs.
        </p>
        {imageUrl.trim() && (
          <div className="mt-3">
            <img
              src={imageUrl.trim()}
              alt="preview"
              className="max-h-32 rounded-lg border border-white/10 bg-navy-950/40"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
      </Section>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <button
            onClick={save}
            disabled={saving || running}
            title={running ? "Pare o bot antes de alterar a configuração" : ""}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <SaveIcon className="w-4 h-4" />
            {saving ? "Salvando…" : "SALVAR CONFIGURAÇÃO"}
          </button>
          {running && (
            <span className="text-xs text-amber-300">
              Bot rodando — pare em "Controle" antes de salvar.
            </span>
          )}
          {feedback && (
            <span className={`text-sm ${feedback.startsWith("Configuração") || feedback.startsWith("importado") ? "text-emerald-300" : "text-rose-300"}`}>
              {feedback}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportConfig}
            className="btn-secondary"
            title="Baixar configuração como JSON"
          >
            <ExportIcon className="w-3.5 h-3.5" />
            Exportar config
          </button>
          <button
            onClick={() => importRef.current?.click()}
            className="btn-secondary"
            title="Importar configuração de um arquivo JSON"
          >
            <ImportIcon className="w-3.5 h-3.5" />
            Importar config
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-2">{title}</div>
      {children}
    </div>
  );
}

function OrgRow({
  org,
  mode,
  checked,
  markedForDelete,
  onToggle,
  onToggleDelete,
  onShowChannels,
  expanded,
}: {
  org: Org;
  mode: "normal" | "delete";
  checked: boolean;
  markedForDelete: boolean;
  onToggle: () => void;
  onToggleDelete: () => void;
  onShowChannels: () => void;
  expanded: boolean;
}) {
  const [channels, setChannels] = useState<OrgChannel[] | null>(null);

  useEffect(() => {
    if (expanded && channels === null) {
      api<OrgChannel[]>(`/api/orgs/${org.id}/channels`)
        .then(setChannels)
        .catch(() => setChannels([]));
    }
  }, [expanded, channels, org.id]);

  const rowBg =
    mode === "delete" && markedForDelete
      ? "bg-rose-500/10 ring-1 ring-rose-400/40"
      : "hover:bg-white/5";

  return (
    <div className={`rounded-lg ${rowBg}`}>
      <div className="flex items-center gap-3 px-2 py-1.5">
        {mode === "delete" ? (
          <input
            type="checkbox"
            checked={markedForDelete}
            onChange={onToggleDelete}
            className="w-4 h-4 accent-rose-500"
            title="Marcar para apagar"
          />
        ) : (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="w-4 h-4 accent-accent"
          />
        )}
        <span className="text-sm text-slate-200">{org.name}</span>
        {org.guild_id ? (
          <span className="text-[10px] text-slate-500 font-mono">
            {org.guild_id.slice(0, 6)}…{org.guild_id.slice(-4)}
          </span>
        ) : (
          <span className="text-[10px] text-rose-400/80 uppercase tracking-wider">
            sem guild_id
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {(org.channels_count ?? 0) > 0 && (
            <button
              type="button"
              onClick={onShowChannels}
              className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30 hover:bg-emerald-400/20"
            >
              {org.channels_count} {(org.channels_count ?? 0) === 1 ? "fila" : "filas"}
            </button>
          )}
          <span className="text-[11px] text-slate-500">limite {org.max_queues}</span>
        </span>
      </div>

      {expanded && (
        <div className="px-2 pb-3">
          {channels === null && (
            <div className="text-xs text-slate-500 px-2 py-2">Carregando…</div>
          )}
          {channels && channels.length === 0 && (
            <div className="text-xs text-slate-500 px-2 py-2">
              Nenhum canal cadastrado.
            </div>
          )}
          {channels && channels.length > 0 && (
            <div className="space-y-1.5">
              {channels.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg bg-navy-950/80 border border-white/10 px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-xs flex-wrap">
                    {c.mode && (
                      <span className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent ring-1 ring-accent/30 font-bold">
                        {c.mode}
                      </span>
                    )}
                    {c.category && (
                      <span className="px-1.5 py-0.5 rounded-md bg-violet-400/10 text-violet-300 ring-1 ring-violet-400/30">
                        {c.category}
                      </span>
                    )}
                    <span className="text-slate-200 font-medium">
                      #{c.channel_name}
                    </span>
                    {c.embed_title && (
                      <span className="text-slate-400 italic truncate max-w-[180px]">
                        “{c.embed_title}”
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-slate-500">
                      {c.channel_id}
                    </span>
                  </div>
                  {c.buttons.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.buttons.map((b, idx) => (
                        <span
                          key={idx}
                          className={
                            b.action === "leave"
                              ? "px-1.5 py-0.5 rounded-md text-[10px] bg-rose-400/10 text-rose-300 ring-1 ring-rose-400/20"
                              : b.action === "enter"
                              ? "px-1.5 py-0.5 rounded-md text-[10px] bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20"
                              : b.action === "play"
                              ? "px-1.5 py-0.5 rounded-md text-[10px] bg-sky-400/10 text-sky-300 ring-1 ring-sky-400/20"
                              : "px-1.5 py-0.5 rounded-md text-[10px] bg-white/5 text-slate-400 ring-1 ring-white/10"
                          }
                          title={b.custom_id ?? ""}
                        >
                          {b.label || "(sem label)"}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlusIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" />
    </svg>
  );
}

function CheckIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l5 5 9-11" />
    </svg>
  );
}

function TrashIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm3 2v9h2v-9H9zm4 0v9h2v-9h-2z" />
    </svg>
  );
}

function TokenStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    connected: { label: "conectado", cls: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30" },
    disconnected: { label: "desconectado", cls: "bg-amber-400/15 text-amber-300 ring-amber-400/30" },
    invalid: { label: "inválido", cls: "bg-rose-400/15 text-rose-300 ring-rose-400/30" },
    rate_limited: { label: "rate-limited", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
    unknown: { label: "aguardando", cls: "bg-white/5 text-slate-400 ring-white/10" },
  };
  const m = map[status] ?? map.unknown;
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${m.cls}`}>
      {m.label}
    </span>
  );
}

function SettingsIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3h-4l-.4 2.4a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2L4.6 14.6l2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1L11 21h4l.4-2.4a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2.1-1.6zM12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>);
}
function SaveIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zM12 19a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM7 8h7V5H7v3z"/></svg>);
}
function ExportIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M13 3v8h3l-4 5-4-5h3V3h2zm-9 16h16v2H4v-2z"/></svg>);
}
function ImportIcon({ className = "" }) {
  return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M11 3v8H8l4 5 4-5h-3V3h-2zm-7 16h16v2H4v-2z"/></svg>);
}
