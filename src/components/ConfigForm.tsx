import { useEffect, useMemo, useRef, useState } from "react";
import type { Org, OrgChannel, MatchType } from "@shared/types";
import { api } from "@/lib/api";

type Category = "Mobile" | "Misto" | "Emulador" | "Tatico" | "Full-Soco";

const ALL_CATEGORIES: Category[] = [
  "Mobile",
  "Misto",
  "Emulador",
  "Tatico",
  "Full-Soco",
];

const MATCH_TYPE_BADGES: Record<MatchType, { emoji: string; label: string; cls: string }> = {
  thread:          { emoji: "📍", label: "thread",  cls: "text-sky-300 bg-sky-400/10 ring-sky-400/30" },
  private_channel: { emoji: "📺", label: "private", cls: "text-violet-300 bg-violet-400/10 ring-violet-400/30" },
  mixed:           { emoji: "🔀", label: "mixed",   cls: "text-amber-300 bg-amber-400/10 ring-amber-400/30" },
};

type TokenPoolEntry = {
  id: number;
  label: string | null;
  value_preview: string;
  status: string;
  username: string | null;
};

type TimingPreset = "seguro" | "intermediario" | "agressivo" | "ultra" | "personalizado";

interface TimingValues {
  intraMin: number; intraMax: number;
  pauseMin: number; pauseMax: number;
  clickMin: number; clickMax: number;
}

const TIMING_PRESETS: Record<Exclude<TimingPreset, "personalizado">, TimingValues> = {
  seguro:        { intraMin: 7000,  intraMax: 12000, pauseMin: 45000, pauseMax: 60000, clickMin: 1500, clickMax: 3000 },
  intermediario: { intraMin: 4000,  intraMax: 7000,  pauseMin: 25000, pauseMax: 35000, clickMin: 1000, clickMax: 2000 },
  agressivo:     { intraMin: 2000,  intraMax: 4000,  pauseMin: 12000, pauseMax: 20000, clickMin: 500,  clickMax: 1000 },
  ultra:         { intraMin: 800,   intraMax: 1800,  pauseMin: 6000,  pauseMax: 10000, clickMin: 200,  clickMax: 600  },
};

function msToS(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : String(s).replace('.', ',');
}

function parseS(raw: string): number | null {
  const n = parseFloat(raw.trim().replace(',', '.'));
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

function detectPreset(v: TimingValues): TimingPreset {
  for (const [key, p] of Object.entries(TIMING_PRESETS) as [Exclude<TimingPreset,"personalizado">, TimingValues][]) {
    if (v.intraMin === p.intraMin && v.intraMax === p.intraMax &&
        v.pauseMin === p.pauseMin && v.pauseMax === p.pauseMax &&
        v.clickMin === p.clickMin && v.clickMax === p.clickMax) return key;
  }
  return "personalizado";
}

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
    blocked_names: string;
    max_valor: number;
    token_strategy: string;
    token_strategy_n: number;
    timing_intra_min_ms: number;
    timing_intra_max_ms: number;
    timing_pause_min_ms: number;
    timing_pause_max_ms: number;
    timing_click_min_ms: number;
    timing_click_max_ms: number;
    clicks_per_org: number;
    hot_org_extra_clicks: number;
    match_msg_delay_ms: number;
    match_msg_delay_min_ms: number;
    match_msg_delay_max_ms: number;
    entry_cap_with_players_per_60s: number;
    entry_cap_empty_per_60s: number;
    entry_cap_total_per_60s: number;
    refusal_check_delay_ms: number;
    enable_60rpm_mode?: boolean;
    active_queue_soft_limit?: number;
    active_queue_hard_limit?: number;
    optimize_for_conversion?: boolean;
    only_empty_queues?: boolean;
  } | null;
  token_pool: TokenPoolEntry[];
  selected_token_ids: number[];
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
  isAdmin = false,
}: {
  instanceId: number;
  running: boolean;
  onSaved: () => void;
  isAdmin?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [data, setData] = useState<ConfigPayload | null>(null);
  const [allowedCats, setAllowedCats] = useState<Set<Category>>(
    new Set<Category>(["Mobile"]),
  );
  const [delay, setDelay] = useState(12);
  const [rotation, setRotation] = useState(90);
  const [timing, setTiming] = useState<TimingValues>(TIMING_PRESETS.intermediario);
  const [timingPreset, setTimingPreset] = useState<TimingPreset>("intermediario");
  const [allowedModes, setAllowedModes] = useState("1x1\n3x3");
  const [messageMain, setMessageMain] = useState("");
  const [messagePerOrg, setMessagePerOrg] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [blockedNames, setBlockedNames] = useState("");
  const [maxValor, setMaxValor] = useState(0);
  const [clicksPerOrg, setClicksPerOrg] = useState(10);
  const [hotOrgExtraClicks, setHotOrgExtraClicks] = useState(10);
  const [matchMsgDelayMinSec, setMatchMsgDelayMinSec] = useState(0);
  const [matchMsgDelayMaxSec, setMatchMsgDelayMaxSec] = useState(0);
  const [entryCapWithPlayers, setEntryCapWithPlayers] = useState(30);
  const [entryCapEmpty, setEntryCapEmpty] = useState(18);
  const [entryCapTotal, setEntryCapTotal] = useState(48);
  const [refusalCheckDelayMs, setRefusalCheckDelayMs] = useState(800);
  const [enable60RpmMode, setEnable60RpmMode] = useState(false);
  const [aqSoftLimit, setAqSoftLimit] = useState(120);
  const [aqHardLimit, setAqHardLimit] = useState(180);
  const [optimizeForConversion, setOptimizeForConversion] = useState(false);
  const [onlyEmptyQueues, setOnlyEmptyQueues] = useState(false);
  const [tokenStrategy, setTokenStrategy] = useState("single");
  const [tokenStrategyN, setTokenStrategyN] = useState(5);
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<number>>(new Set());
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<number>>(new Set());
  const [tokenPool, setTokenPool] = useState<TokenPoolEntry[]>([]);
  const [tokensMode, setTokensMode] = useState<"normal" | "delete" | "add">("normal");
  const [tokenDeleteSet, setTokenDeleteSet] = useState<Set<number>>(new Set());
  const [busyTokens, setBusyTokens] = useState(false);
  const [newTokenValue, setNewTokenValue] = useState("");
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [revealedTokens, setRevealedTokens] = useState<Map<number, string>>(new Map());
  const [loadingReveal, setLoadingReveal] = useState<Set<number>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openOrgId, setOpenOrgId] = useState<number | null>(null);
  const [orgsMode, setOrgsMode] = useState<"normal" | "delete" | "add">("normal");
  const [deleteSet, setDeleteSet] = useState<Set<number>>(new Set());
  const [busyOrgs, setBusyOrgs] = useState(false);
  const [rediscovering, setRediscovering] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | MatchType>("all");
  const [detectedTypes, setDetectedTypes] = useState<Map<number, string>>(new Map());
  const [typeMetrics, setTypeMetrics] = useState<{
    active_queues: Record<string, number>;
    matches: Record<string, number>;
    orgs: Record<string, number>;
    ghosts: Record<string, number>;
    uncorrelated: number;
  } | null>(null);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgGuild, setNewOrgGuild] = useState("");
  const [newOrgPriority, setNewOrgPriority] = useState(1);
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
      setBlockedNames(cfg.config.blocked_names ?? "");
      setMaxValor(Number(cfg.config.max_valor ?? 0));
      setClicksPerOrg(Number(cfg.config.clicks_per_org ?? 10));
      setHotOrgExtraClicks(Number(cfg.config.hot_org_extra_clicks ?? 10));
      const minMs = Number(cfg.config.match_msg_delay_min_ms ?? cfg.config.match_msg_delay_ms ?? 0);
      const maxMs = Number(cfg.config.match_msg_delay_max_ms ?? minMs);
      setMatchMsgDelayMinSec(Math.round(minMs / 1000));
      setMatchMsgDelayMaxSec(Math.round(maxMs / 1000));
      setEntryCapWithPlayers(Number(cfg.config.entry_cap_with_players_per_60s ?? 30));
      setEntryCapEmpty(Number(cfg.config.entry_cap_empty_per_60s ?? 18));
      setEntryCapTotal(Number(cfg.config.entry_cap_total_per_60s ?? 48));
      setRefusalCheckDelayMs(Number(cfg.config.refusal_check_delay_ms ?? 800));
      setEnable60RpmMode(Boolean(cfg.config.enable_60rpm_mode ?? false));
      setAqSoftLimit(Number(cfg.config.active_queue_soft_limit ?? 120));
      setAqHardLimit(Number(cfg.config.active_queue_hard_limit ?? 180));
      setOptimizeForConversion(Boolean((cfg.config as any).optimize_for_conversion ?? false));
      setOnlyEmptyQueues(Boolean((cfg.config as any).only_empty_queues ?? false));
      setTokenStrategy(cfg.config.token_strategy ?? "single");
      setTokenStrategyN(Number(cfg.config.token_strategy_n ?? 5));
      const tv: TimingValues = {
        intraMin: cfg.config.timing_intra_min_ms ?? 4000,
        intraMax: cfg.config.timing_intra_max_ms ?? 7000,
        pauseMin: cfg.config.timing_pause_min_ms ?? 25000,
        pauseMax: cfg.config.timing_pause_max_ms ?? 35000,
        clickMin: cfg.config.timing_click_min_ms ?? 1000,
        clickMax: cfg.config.timing_click_max_ms ?? 2000,
      };
      setTiming(tv);
      setTimingPreset(detectPreset(tv));
    }
    setSelectedOrgIds(new Set(cfg.selected_org_ids));
    setSelectedTokenIds(new Set(cfg.selected_token_ids ?? []));
    setTokenPool(cfg.token_pool ?? []);
    setLoading(false);
  }

  async function reloadTokenPool() {
    const rows = await api<TokenPoolEntry[]>(`/api/tokens?instance_id=${instanceId}`);
    setTokenPool(rows);
  }

  useEffect(() => {
    reload().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  async function reloadOrgs() {
    const rows = await api<Org[]>(`/api/orgs?instance_id=${instanceId}`);
    setOrgs(rows);
    const detected = await api<Array<{ org_id: number; detected_type: string }>>(`/api/orgs/detected-types`).catch(() => []);
    setDetectedTypes(new Map(detected.map((d) => [d.org_id, d.detected_type])));
  }

  useEffect(() => {
    reloadOrgs().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  useEffect(() => {
    function fetchMetrics() {
      api<{ active_queues: Record<string, number>; matches: Record<string, number>; orgs: Record<string, number>; ghosts: Record<string, number>; uncorrelated: number }>(
        `/api/orgs/type-metrics?instance_id=${instanceId}`,
      ).then(setTypeMetrics).catch(() => {});
    }
    fetchMetrics();
    const t = setInterval(fetchMetrics, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  const typeCounts = useMemo(() => ({
    thread: orgs.filter((o) => (o.match_type ?? "thread") === "thread").length,
    private_channel: orgs.filter((o) => o.match_type === "private_channel").length,
    mixed: orgs.filter((o) => o.match_type === "mixed").length,
  }), [orgs]);

  const filteredOrgs = useMemo(() =>
    typeFilter === "all" ? orgs : orgs.filter((o) => (o.match_type ?? "thread") === typeFilter),
    [orgs, typeFilter],
  );

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
    setNewOrgPriority(1);
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

  async function forceRediscover() {
    setRediscovering(true);
    setFeedback("Forçando redescoberta de canais…");
    try {
      const r = await api<{ ok: boolean; results: { ok: boolean; channels_found?: number; queues_saved?: number; error?: string }[] }>(
        `/api/discovery/${instanceId}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await reloadOrgs();
      const totalCh = (r.results ?? []).reduce((s, x) => s + (x.channels_found ?? 0), 0);
      const totalQ = (r.results ?? []).reduce((s, x) => s + (x.queues_saved ?? 0), 0);
      const n = r.results?.length ?? 0;
      if (n === 0) {
        setFeedback("Nenhuma org com guild_id configurado para descobrir.");
      } else {
        setFeedback(`Redescoberta concluída: ${totalCh} canal(is) em ${n} org(s), ${totalQ} fila(s) cadastrada(s).`);
      }
      setTimeout(() => setFeedback(null), 6000);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Erro ao redescobrir");
    } finally {
      setRediscovering(false);
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
          category: "Mobile",
          guild_id: newOrgGuild.trim() || null,
          priority: newOrgPriority,
          instance_id: instanceId,
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

  const tokensCount = selectedTokenIds.size;
  const tokensActive = useMemo(
    () => tokenPool.filter((t) => selectedTokenIds.has(t.id) && t.status === "connected").length,
    [tokenPool, selectedTokenIds]
  );

  function toggleOrg(id: number) {
    setSelectedOrgIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function toggleToken(id: number) {
    setSelectedTokenIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
      } else {
        if (n.size >= 5) {
          setFeedback("Máximo de 5 tokens por instância.");
          setTimeout(() => setFeedback(null), 3000);
          return prev;
        }
        n.add(id);
      }
      return n;
    });
  }

  function cancelTokensAction() {
    setTokensMode("normal");
    setTokenDeleteSet(new Set());
    setNewTokenValue("");
    setNewTokenLabel("");
  }

  function toggleTokenDelete(id: number) {
    setTokenDeleteSet((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function toggleRevealToken(id: number) {
    if (revealedTokens.has(id)) {
      setRevealedTokens((prev) => { const n = new Map(prev); n.delete(id); return n; });
      return;
    }
    setLoadingReveal((prev) => new Set(prev).add(id));
    try {
      const data = await api<{ value: string }>(`/api/tokens/${id}/value`);
      setRevealedTokens((prev) => new Map(prev).set(id, data.value));
    } catch {
      setFeedback("Erro ao revelar token.");
      setTimeout(() => setFeedback(null), 3000);
    } finally {
      setLoadingReveal((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  async function confirmTokenDelete() {
    if (tokenDeleteSet.size === 0) { cancelTokensAction(); return; }
    setBusyTokens(true);
    try {
      for (const id of tokenDeleteSet) {
        // Passa instance_id para remover apenas da seleção desta instância
        await api(`/api/tokens/${id}?instance_id=${instanceId}`, { method: "DELETE" });
      }
      setSelectedTokenIds((prev) => {
        const n = new Set(prev);
        for (const id of tokenDeleteSet) n.delete(id);
        return n;
      });
      cancelTokensAction();
      await reloadTokenPool();
      setFeedback(`${tokenDeleteSet.size} token(s) removido(s) desta instância.`);
      setTimeout(() => setFeedback(null), 3000);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Erro ao apagar token");
    } finally {
      setBusyTokens(false);
    }
  }

  async function confirmTokenAdd() {
    const val = newTokenValue.trim();
    if (!val) { setFeedback("Informe o valor do token."); return; }
    setBusyTokens(true);
    try {
      await api(`/api/tokens`, {
        method: "POST",
        body: JSON.stringify({ value: val, label: newTokenLabel.trim() || null, instance_id: instanceId }),
      });
      cancelTokensAction();
      await reloadTokenPool();
      setFeedback("Token adicionado ao pool.");
      setTimeout(() => setFeedback(null), 3000);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Erro ao adicionar token");
    } finally {
      setBusyTokens(false);
    }
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
          blocked_names: blockedNames,
          max_valor: maxValor,
          clicks_per_org: clicksPerOrg,
          hot_org_extra_clicks: hotOrgExtraClicks,
          token_strategy: tokenStrategy,
          token_strategy_n: tokenStrategyN,
          selected_token_ids: Array.from(selectedTokenIds),
          selected_org_ids: Array.from(selectedOrgIds),
          timing_intra_min_ms: timing.intraMin,
          timing_intra_max_ms: timing.intraMax,
          timing_pause_min_ms: timing.pauseMin,
          timing_pause_max_ms: timing.pauseMax,
          timing_click_min_ms: timing.clickMin,
          timing_click_max_ms: timing.clickMax,
          match_msg_delay_ms: matchMsgDelayMinSec * 1000,
          match_msg_delay_min_ms: matchMsgDelayMinSec * 1000,
          match_msg_delay_max_ms: Math.max(matchMsgDelayMinSec, matchMsgDelayMaxSec) * 1000,
          entry_cap_with_players_per_60s: entryCapWithPlayers,
          entry_cap_empty_per_60s: entryCapEmpty,
          entry_cap_total_per_60s: entryCapTotal,
          refusal_check_delay_ms: refusalCheckDelayMs,
          enable_60rpm_mode: enable60RpmMode,
          active_queue_soft_limit: aqSoftLimit,
          active_queue_hard_limit: aqHardLimit,
          optimize_for_conversion: optimizeForConversion,
          only_empty_queues: onlyEmptyQueues,
        }),
      });
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
    a.download = `empire-config-${instanceId}.json`;
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

  async function handleImportFromBot1() {
    try {
      setFeedback(null);
      const json = await api<object>(`/api/config/1/export`);
      await api(`/api/config/${instanceId}/import`, {
        method: "POST",
        body: JSON.stringify(json),
      });
      await reload();
      await reloadOrgs();
      setFeedback("Configuração importada com sucesso.");
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Erro ao importar do BOT1");
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

      <Section title="Selecionar tokens (até 5)">
        <div className="rounded-xl bg-navy-950/60 border border-white/10 p-3 space-y-1.5">
          {tokenPool.length === 0 && (
            <div className="text-sm text-slate-500">Nenhum token cadastrado no pool.</div>
          )}
          {tokenPool.map((t) => {
            const isSelected = selectedTokenIds.has(t.id);
            const isMarked = tokenDeleteSet.has(t.id);
            const rowBg = tokensMode === "delete" && isMarked
              ? "bg-rose-500/10 ring-1 ring-rose-400/40"
              : "hover:bg-white/5";
            return (
              <div key={t.id} className={`rounded-lg ${rowBg}`}>
                <div className="flex items-center gap-3 px-2 py-1.5">
                  {tokensMode === "delete" ? (
                    <input
                      type="checkbox"
                      checked={isMarked}
                      onChange={() => toggleTokenDelete(t.id)}
                      className="w-4 h-4 accent-rose-500"
                    />
                  ) : (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleToken(t.id)}
                      className="w-4 h-4 accent-accent"
                    />
                  )}
                  {t.label && (
                    <span className="text-sm text-slate-200 font-medium">{t.label}</span>
                  )}
                  <span className="font-mono text-xs text-slate-400 flex-1 truncate">
                    {revealedTokens.has(t.id) ? revealedTokens.get(t.id) : t.value_preview}
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      title={revealedTokens.has(t.id) ? "Esconder token" : "Revelar token"}
                      onClick={() => toggleRevealToken(t.id)}
                      disabled={loadingReveal.has(t.id)}
                      className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40"
                    >
                      {loadingReveal.has(t.id) ? (
                        <SpinnerIcon className="w-4 h-4 animate-spin" />
                      ) : revealedTokens.has(t.id) ? (
                        <EyeOffIcon className="w-4 h-4" />
                      ) : (
                        <EyeIcon className="w-4 h-4" />
                      )}
                    </button>
                  )}
                  {t.username && (
                    <span className="text-sm text-slate-200 truncate max-w-[160px]">{t.username}</span>
                  )}
                  <TokenStatus status={t.status} />
                </div>
              </div>
            );
          })}
        </div>

        {tokensMode === "normal" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setTokensMode("add")} className="btn-secondary">
              <PlusIcon className="w-4 h-4" />
              Adicionar token
            </button>
            <button
              type="button"
              onClick={() => setTokensMode("delete")}
              disabled={tokenPool.length === 0}
              className="btn-secondary text-rose-300 ring-rose-400/30 hover:ring-rose-400/60 disabled:opacity-40"
            >
              <TrashIcon className="w-4 h-4" />
              Remover do pool
            </button>
            <span className="text-xs text-slate-500 ml-1">
              {selectedTokenIds.size}/5 selecionado(s)
            </span>
          </div>
        )}

        {tokensMode === "delete" && (
          <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/5 p-3">
            <div className="text-xs text-rose-200/90 mb-2">
              Marque os tokens que deseja remover desta instância. Outras instâncias não serão afetadas.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={confirmTokenDelete}
                disabled={busyTokens || tokenDeleteSet.size === 0}
                className="btn-danger disabled:opacity-50"
              >
                <TrashIcon className="w-4 h-4" />
                {busyTokens ? "Removendo…" : `Confirmar (${tokenDeleteSet.size})`}
              </button>
              <button type="button" onClick={cancelTokensAction} disabled={busyTokens} className="btn-secondary disabled:opacity-50">
                Cancelar
              </button>
            </div>
          </div>
        )}

        {tokensMode === "add" && (
          <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
            <div className="text-xs text-slate-400">
              Cole o token do Discord. O apelido é opcional (só para identificação visual).
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <input
                className="input font-mono text-xs sm:col-span-1"
                placeholder="Token (obrigatório)"
                value={newTokenValue}
                onChange={(e) => setNewTokenValue(e.target.value)}
                autoFocus
                type="password"
              />
              <input
                className="input sm:col-span-1"
                placeholder="Apelido (opcional, ex: conta1)"
                value={newTokenLabel}
                onChange={(e) => setNewTokenLabel(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={confirmTokenAdd}
                disabled={busyTokens || !newTokenValue.trim()}
                className="btn-primary disabled:opacity-50"
              >
                <PlusIcon className="w-4 h-4" />
                {busyTokens ? "Adicionando…" : "Confirmar"}
              </button>
              <button type="button" onClick={cancelTokensAction} disabled={busyTokens} className="btn-secondary disabled:opacity-50">
                Cancelar
              </button>
            </div>
          </div>
        )}
      </Section>

      <div className="grid sm:grid-cols-3 gap-4">
        <Section title="Rotação de token (minutos)">
          <input
            type="number" min={1} className="input"
            value={rotation} onChange={(e) => setRotation(Number(e.target.value))}
          />
          <p className="text-xs text-slate-500 mt-2">
            Tokens ativos: <b className="text-slate-300">{tokensActive}/{tokensCount}</b>
          </p>
        </Section>
        {isAdmin && (
        <Section title="Intervalo do ciclo (s)">
          <input
            type="number" min={1} max={300} className="input"
            value={delay} onChange={(e) => setDelay(Math.max(1, Number(e.target.value)))}
          />
          <p className="text-xs text-slate-500 mt-2">
            Pausa entre uma rodada completa e a próxima (±30% jitter).
          </p>
        </Section>
        )}
        <Section title="Velocidade de entrada">
          <div className="flex gap-2 flex-wrap mb-3">
            {(["seguro", "intermediario", "agressivo", "ultra", "personalizado"] as TimingPreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setTimingPreset(p);
                  if (p !== "personalizado") setTiming(TIMING_PRESETS[p]);
                }}
                className={
                  "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors " +
                  (timingPreset === p
                    ? p === "seguro" ? "bg-emerald-600/20 border-emerald-500/60 text-emerald-300"
                      : p === "intermediario" ? "bg-accent/20 border-accent/60 text-accent"
                      : p === "agressivo" ? "bg-red-600/20 border-red-500/60 text-red-300"
                      : p === "ultra" ? "bg-orange-600/20 border-orange-500/60 text-orange-300"
                      : "bg-purple-600/20 border-purple-500/60 text-purple-300"
                    : "bg-navy-950/60 border-white/10 text-slate-400 hover:border-white/30")
                }
              >
                {p === "seguro" ? "Seguro" : p === "intermediario" ? "Intermediário" : p === "agressivo" ? "Agressivo" : p === "ultra" ? "⚡ Ultra" : "Personalizado"}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-400">
            <div>
              <p className="mb-1">Delay entre entradas (s)</p>
              <div className="flex gap-2 items-center">
                <input type="text" inputMode="decimal" className="input py-1 text-xs w-full" disabled={timingPreset !== "personalizado"}
                  defaultValue={msToS(timing.intraMin)} key={`intraMin-${timingPreset}`}
                  onBlur={(e) => { const v = parseS(e.target.value); if (v) setTiming(t => ({ ...t, intraMin: v })); else e.target.value = msToS(timing.intraMin); }} />
                <span className="text-slate-500">–</span>
                <input type="text" inputMode="decimal" className="input py-1 text-xs w-full" disabled={timingPreset !== "personalizado"}
                  defaultValue={msToS(timing.intraMax)} key={`intraMax-${timingPreset}`}
                  onBlur={(e) => { const v = parseS(e.target.value); if (v) setTiming(t => ({ ...t, intraMax: v })); else e.target.value = msToS(timing.intraMax); }} />
              </div>
            </div>
            <div>
              <p className="mb-1">Pausa após atingir limite (s)</p>
              <div className="flex gap-2 items-center">
                <input type="text" inputMode="decimal" className="input py-1 text-xs w-full" disabled={timingPreset !== "personalizado"}
                  defaultValue={msToS(timing.pauseMin)} key={`pauseMin-${timingPreset}`}
                  onBlur={(e) => { const v = parseS(e.target.value); if (v) setTiming(t => ({ ...t, pauseMin: v })); else e.target.value = msToS(timing.pauseMin); }} />
                <span className="text-slate-500">–</span>
                <input type="text" inputMode="decimal" className="input py-1 text-xs w-full" disabled={timingPreset !== "personalizado"}
                  defaultValue={msToS(timing.pauseMax)} key={`pauseMax-${timingPreset}`}
                  onBlur={(e) => { const v = parseS(e.target.value); if (v) setTiming(t => ({ ...t, pauseMax: v })); else e.target.value = msToS(timing.pauseMax); }} />
              </div>
            </div>
            <div className="col-span-2">
              <p className="mb-1">Delay antes do clique (s)</p>
              <div className="flex gap-2 items-center max-w-xs">
                <input type="text" inputMode="decimal" className="input py-1 text-xs w-full" disabled={timingPreset !== "personalizado"}
                  defaultValue={msToS(timing.clickMin)} key={`clickMin-${timingPreset}`}
                  onBlur={(e) => { const v = parseS(e.target.value); if (v) setTiming(t => ({ ...t, clickMin: v })); else e.target.value = msToS(timing.clickMin); }} />
                <span className="text-slate-500">–</span>
                <input type="text" inputMode="decimal" className="input py-1 text-xs w-full" disabled={timingPreset !== "personalizado"}
                  defaultValue={msToS(timing.clickMax)} key={`clickMax-${timingPreset}`}
                  onBlur={(e) => { const v = parseS(e.target.value); if (v) setTiming(t => ({ ...t, clickMax: v })); else e.target.value = msToS(timing.clickMax); }} />
              </div>
            </div>
            <div className="col-span-2">
              <p className="mb-1">Delay verificação de recusa (ms)</p>
              <div className="flex gap-2 items-center max-w-xs">
                <input
                  type="number"
                  inputMode="numeric"
                  className="input py-1 text-xs w-full"
                  min={300}
                  max={5000}
                  step={100}
                  value={refusalCheckDelayMs}
                  onChange={(e) => setRefusalCheckDelayMs(Math.min(5000, Math.max(300, Number(e.target.value))))}
                />
                <span className="text-slate-500 whitespace-nowrap">
                  {refusalCheckDelayMs <= 500 ? "⚡ rápido" : refusalCheckDelayMs <= 1200 ? "balanceado" : "conservador"}
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-1">Tempo que o bot aguarda após o clique antes de ler a resposta da org (async — não bloqueia o próximo clique). Padrão: 800ms.</p>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {timingPreset === "seguro" && "Pausas longas, menos detecção — recomendado para contas novas."}
            {timingPreset === "intermediario" && "Equilíbrio entre velocidade e segurança (padrão)."}
            {timingPreset === "agressivo" && "Entradas rápidas — maior risco de detecção/ban."}
            {timingPreset === "ultra" && "⚡ Máxima velocidade — use apenas com contas antigas e em baixa concorrência. Alto risco de ban."}
            {timingPreset === "personalizado" && "Valores personalizados. Edite os campos acima."}
          </p>
        </Section>
      </div>

      <Section title="Delay antes da mensagem de partida (seg)">
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-slate-500">Mín</span>
            <input
              className="input w-20 text-center"
              type="number"
              min={0}
              step={1}
              placeholder="0"
              value={matchMsgDelayMinSec}
              onChange={(e) => {
                const v = Math.max(0, Number(e.target.value));
                setMatchMsgDelayMinSec(v);
                if (matchMsgDelayMaxSec < v) setMatchMsgDelayMaxSec(v);
              }}
            />
          </div>
          <span className="text-slate-500 mt-4">–</span>
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-slate-500">Máx</span>
            <input
              className="input w-20 text-center"
              type="number"
              min={matchMsgDelayMinSec}
              step={1}
              placeholder="0"
              value={matchMsgDelayMaxSec}
              onChange={(e) => setMatchMsgDelayMaxSec(Math.max(matchMsgDelayMinSec, Number(e.target.value)))}
            />
          </div>
          <span className="text-slate-400 text-sm mt-4">
            {matchMsgDelayMinSec === 0 && matchMsgDelayMaxSec === 0
              ? "Envio imediato"
              : matchMsgDelayMinSec === matchMsgDelayMaxSec
              ? `${matchMsgDelayMinSec}s fixo`
              : `${matchMsgDelayMinSec}–${matchMsgDelayMaxSec}s aleatório`}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Cada envio sorteia um valor dentro do intervalo. Se mín = máx, o delay é fixo. O envio roda em paralelo com os cliques — não bloqueia nenhum dos dois.
        </p>
      </Section>

      <Section title="Cliques por org antes de avançar">
        <div className="flex items-center gap-3">
          <input
            className="input w-24"
            type="number"
            min={0}
            step={1}
            placeholder="10"
            value={clicksPerOrg}
            onChange={(e) => setClicksPerOrg(Math.max(0, Number(e.target.value)))}
          />
          <span className="text-slate-400 text-sm">
            {clicksPerOrg === 0 ? "Sem limite" : `${clicksPerOrg} cliques → próxima org`}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Após esse número de entradas em uma org, o bot avança para a próxima — independente de quantas filas entrou. Cole <b className="text-white/50">0</b> para desativar.
        </p>
      </Section>

      {isAdmin && (
      <Section title="Cliques extras em org quente">
        <div className="flex items-center gap-3">
          <input
            className="input w-24"
            type="number"
            min={0}
            max={50}
            step={1}
            placeholder="10"
            value={hotOrgExtraClicks}
            onChange={(e) => setHotOrgExtraClicks(Math.min(50, Math.max(0, Number(e.target.value))))}
          />
          <span className="text-slate-400 text-sm">
            {hotOrgExtraClicks === 0 ? "Desativado" : `+${hotOrgExtraClicks} cliques quando org tem ≥5 filas livres`}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Quando uma org ainda tem muitas filas elegíveis e nenhuma recusa recente, o bot estende o limite de cliques por org em até esse valor — evita trocar de org prematuramente e aumenta o throughput.
        </p>
      </Section>
      )}

      {isAdmin && (
      <Section title="Entradas por janela (60s)">
        <div className="flex flex-wrap gap-2 mb-3">
          {([
            { label: "Conservador", players: 15, empty: 9, total: 24 },
            { label: "Agressivo",   players: 30, empty: 18, total: 48 },
          ] as const).map((p) => {
            const active = entryCapWithPlayers === p.players && entryCapEmpty === p.empty && entryCapTotal === p.total;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => { setEntryCapWithPlayers(p.players); setEntryCapEmpty(p.empty); setEntryCapTotal(p.total); }}
                className={
                  "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors " +
                  (active
                    ? p.label === "Conservador"
                      ? "bg-emerald-600/20 border-emerald-500/60 text-emerald-300"
                      : "bg-red-600/20 border-red-500/60 text-red-300"
                    : "bg-navy-950/60 border-white/10 text-slate-400 hover:border-white/30")
                }
              >
                {p.label}
              </button>
            );
          })}
          {(() => {
            const isCustom =
              !(entryCapWithPlayers === 15 && entryCapEmpty === 9 && entryCapTotal === 24) &&
              !(entryCapWithPlayers === 30 && entryCapEmpty === 18 && entryCapTotal === 48);
            return (
              <button
                type="button"
                onClick={() => {
                  if (!isCustom) {
                    setEntryCapWithPlayers(40);
                    setEntryCapEmpty(30);
                    setEntryCapTotal(70);
                  }
                }}
                className={
                  "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors " +
                  (isCustom
                    ? "bg-purple-600/20 border-purple-500/60 text-purple-300"
                    : "bg-navy-950/60 border-white/10 text-slate-400 hover:border-white/30")
                }
              >
                Personalizado
              </button>
            );
          })()}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-slate-500 mb-1">Com players / 60s</p>
            <input
              type="number" min={0} max={200} className="input text-center"
              value={entryCapWithPlayers}
              onChange={(e) => {
                const v = Math.min(200, Math.max(0, Number(e.target.value)));
                setEntryCapWithPlayers(v);
                setEntryCapTotal(v + entryCapEmpty);
              }}
            />
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">Vazias / 60s</p>
            <input
              type="number" min={0} max={200} className="input text-center"
              value={entryCapEmpty}
              onChange={(e) => {
                const v = Math.min(200, Math.max(0, Number(e.target.value)));
                setEntryCapEmpty(v);
                setEntryCapTotal(entryCapWithPlayers + v);
              }}
            />
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">Total / 60s</p>
            <input
              type="number" className="input text-center opacity-50 cursor-not-allowed"
              value={entryCapTotal}
              readOnly
              tabIndex={-1}
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Controla quantas entradas em fila o bot pode fazer a cada janela de 60 segundos. Valores maiores aumentam agressividade e podem aumentar rate limit.
        </p>
      </Section>
      )}

      {isAdmin && (
      <Section title="Modo Experimental 60/min">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setEnable60RpmMode((v) => !v)}
              className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${enable60RpmMode ? "bg-accent" : "bg-white/10"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${enable60RpmMode ? "translate-x-6" : "translate-x-0"}`} />
            </button>
            <span className={`text-sm font-medium ${enable60RpmMode ? "text-accent" : "text-slate-400"}`}>
              {enable60RpmMode ? "Ativo — throughput máximo habilitado" : "Desativado (modo conservador padrão)"}
            </span>
          </div>
          {enable60RpmMode && (
            <div className="rounded-xl border border-amber-400/30 bg-amber-500/5 p-3 space-y-3">
              <p className="text-xs text-amber-300/80">
                Ativa: cache de active_queues (3s), limites globais de filas, pending_checks ampliado (15), skip de verificação acima de 8 pendentes, modo seguro automático (2min após spike de erros) e log de diagnóstico a cada 30s.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-400 mb-1">Soft limit (≥ só aceita com players)</p>
                  <input
                    type="number" min={10} max={1000} step={10}
                    className="input text-center"
                    value={aqSoftLimit}
                    onChange={(e) => setAqSoftLimit(Math.max(10, Math.min(1000, Number(e.target.value))))}
                  />
                </div>
                <div>
                  <p className="text-xs text-slate-400 mb-1">Hard limit (≥ pausa total)</p>
                  <input
                    type="number" min={10} max={1000} step={10}
                    className="input text-center"
                    value={aqHardLimit}
                    onChange={(e) => setAqHardLimit(Math.max(10, Math.min(1000, Number(e.target.value))))}
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Soft={aqSoftLimit}: acima disso só entra em filas com players. Hard={aqHardLimit}: acima disso pausa até liberar vagas via sweep.
              </p>
            </div>
          )}
        </div>
      </Section>
      )}

      {isAdmin && (
      <Section title="Otimizar para Conversão">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setOptimizeForConversion((v) => !v)}
              className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${optimizeForConversion ? "bg-accent" : "bg-white/10"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${optimizeForConversion ? "translate-x-6" : "translate-x-0"}`} />
            </button>
            <span className={`text-sm font-medium ${optimizeForConversion ? "text-accent" : "text-slate-400"}`}>
              {optimizeForConversion ? "Ativo — modo foco em conversão" : "Desativado (padrão)"}
            </span>
          </div>
          {optimizeForConversion && (
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/5 p-3 space-y-2">
              <p className="text-xs text-emerald-300/80">
                Ativa métricas de conversão por org (janela 15min), skip automático de orgs com ghost_rate alto (penalidade cold de 5min), pre-pass ponderado por taxa de conversão histórica, soft/hard limits independentes de 60rpm e log de eficiência a cada 60s.
              </p>
            </div>
          )}
        </div>
      </Section>
      )}

      <Section title="Apenas Filas Vazias">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setOnlyEmptyQueues((v) => !v)}
              className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${onlyEmptyQueues ? "bg-accent" : "bg-white/10"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${onlyEmptyQueues ? "translate-x-6" : "translate-x-0"}`} />
            </button>
            <span className={`text-sm font-medium ${onlyEmptyQueues ? "text-accent" : "text-slate-400"}`}>
              {onlyEmptyQueues ? "Ativo — entra somente em filas sem players" : "Desativado (padrão)"}
            </span>
          </div>
          {onlyEmptyQueues && (
            <div className="rounded-xl border border-sky-400/30 bg-sky-500/5 p-3 space-y-2">
              <p className="text-xs text-sky-300/80">
                Com este modo ativo, o bot ignora todas as filas que já tenham players e entra somente em filas completamente vazias. Se não houver nenhuma fila vazia disponível em uma org, ela é pulada — sem fallback para filas com players.
              </p>
            </div>
          )}
        </div>
      </Section>

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
        {/* Filtro por tipo de partida */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {(["all", "thread", "private_channel", "mixed"] as const).map((ft) => {
            const count = ft === "all" ? orgs.length
              : ft === "thread" ? typeCounts.thread
              : ft === "private_channel" ? typeCounts.private_channel
              : typeCounts.mixed;
            const badge = ft !== "all" ? MATCH_TYPE_BADGES[ft] : null;
            return (
              <button
                key={ft}
                type="button"
                onClick={() => setTypeFilter(ft)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium ring-1 transition-colors ${
                  typeFilter === ft
                    ? "bg-accent/20 text-accent ring-accent/50"
                    : "bg-white/5 text-slate-400 ring-white/10 hover:ring-white/30"
                }`}
              >
                {badge ? `${badge.emoji} ${badge.label}` : "Todas"} ({count})
              </button>
            );
          })}
        </div>

        <div className="rounded-xl bg-navy-950/60 border border-white/10 p-3 space-y-1.5">
          {orgs.length === 0 && (
            <div className="text-sm text-slate-500">Nenhuma org cadastrada.</div>
          )}
          {orgs.length > 0 && filteredOrgs.length === 0 && (
            <div className="text-sm text-slate-500">Nenhuma org do tipo selecionado.</div>
          )}
          {filteredOrgs.map((o) => (
            <OrgRow
              key={o.id}
              org={o}
              mode={orgsMode === "delete" ? "delete" : "normal"}
              checked={selectedOrgIds.has(o.id)}
              markedForDelete={deleteSet.has(o.id)}
              onToggle={() => toggleOrg(o.id)}
              onToggleDelete={() => toggleDelete(o.id)}
              onShowChannels={() => setOpenOrgId(o.id === openOrgId ? null : o.id)}
              onPriorityChange={async (p) => {
                await api(`/api/orgs/${o.id}`, { method: "PATCH", body: JSON.stringify({ priority: p }) });
                await reloadOrgs();
              }}
              onClearChannels={() => reloadOrgs()}
              onMatchTypeChange={async (t) => {
                await api(`/api/orgs/${o.id}`, { method: "PATCH", body: JSON.stringify({ match_type: t }) });
                await reloadOrgs();
              }}
              detectedMatchType={detectedTypes.get(o.id) ?? null}
              expanded={o.id === openOrgId}
            />
          ))}
        </div>

        {/* Métricas por tipo de partida */}
        {typeMetrics && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["thread", "private_channel", "mixed"] as const).map((mt) => {
              const b = MATCH_TYPE_BADGES[mt];
              return (
                <div
                  key={mt}
                  className={`rounded-lg p-2.5 ring-1 ${b.cls}`}
                  style={{ background: "rgba(0,0,0,0.18)" }}
                >
                  <div className="text-xs font-semibold">{b.emoji} {b.label}</div>
                  <div className="text-[10px] mt-1.5 space-y-0.5 text-left opacity-80">
                    <div>{typeMetrics.orgs[mt] ?? 0} org(s)</div>
                    <div>{typeMetrics.active_queues[mt] ?? 0} fila(s) ativa(s)</div>
                    <div>{typeMetrics.matches[mt] ?? 0} partida(s)</div>
                    <div className="text-rose-300/80">{typeMetrics.ghosts[mt] ?? 0} ghost(s)</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
            {orgs.length > 0 && (
              selectedOrgIds.size === orgs.length ? (
                <button
                  type="button"
                  onClick={() => setSelectedOrgIds(new Set())}
                  className="btn-secondary"
                >
                  Desmarcar todas
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectedOrgIds(new Set(orgs.map((o) => o.id)))}
                  className="btn-secondary"
                >
                  Selecionar todas
                </button>
              )
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={forceRediscover}
                disabled={rediscovering || orgs.length === 0}
                title="Varre novamente todos os canais das orgs selecionadas, mesmo que já tenham sido descobertos antes"
                className="btn-secondary text-sky-300 ring-sky-400/30 hover:ring-sky-400/60 disabled:opacity-40"
              >
                <RefreshIcon className={`w-4 h-4 ${rediscovering ? "animate-spin" : ""}`} />
                {rediscovering ? "Redescubrindo…" : "Forçar redescoberta"}
              </button>
            )}
            <span className="text-xs text-slate-500 ml-1">
              {selectedOrgIds.size > 0 ? `${selectedOrgIds.size}/${orgs.length} selecionada(s)` : "Os canais são descobertos automaticamente ao salvar."}
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
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="Nome da org (ex: Surf)"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                autoFocus
              />
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="guild_id (opcional)"
                value={newOrgGuild}
                onChange={(e) => setNewOrgGuild(e.target.value)}
              />
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-500 px-0.5">Prioridade</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  className="input text-center w-16"
                  value={newOrgPriority}
                  onChange={(e) => setNewOrgPriority(Number(e.target.value))}
                />
              </div>
            </div>
            <p className="text-xs text-slate-600">
              Maior prioridade = visitada primeiro. Orgs com o mesmo valor são tratadas igualmente.
            </p>
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


      <Section title="Rotação de Tokens">
        <div className="flex flex-col gap-3">
          {[
            { value: "single", label: "Token único", desc: "Usa sempre o primeiro token conectado. Simples e estável." },
            { value: "per_n_orgs", label: "Trocar a cada N entradas", desc: "Rotaciona para o próximo token após um número fixo de entradas em fila." },
            { value: "full_cycle", label: "Trocar ao completar ciclo de orgs", desc: "Passa por todas as orgs com o token 1, depois troca para o token 2, e assim por diante." },
          ].map((opt) => (
            <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${tokenStrategy === opt.value ? "border-accent/50 bg-accent/10" : "border-white/10 hover:border-white/20"}`}>
              <input
                type="radio"
                name="token_strategy"
                value={opt.value}
                checked={tokenStrategy === opt.value}
                onChange={() => setTokenStrategy(opt.value)}
                className="mt-0.5 accent-blue-400"
              />
              <div>
                <div className="text-sm font-semibold text-white">{opt.label}</div>
                <div className="text-xs text-slate-400 mt-0.5">{opt.desc}</div>
              </div>
            </label>
          ))}
          {tokenStrategy === "per_n_orgs" && (
            <div className="flex items-center gap-3 mt-1 pl-1">
              <span className="text-sm text-slate-300">Trocar a cada</span>
              <input
                className="input w-20"
                type="number"
                min={1}
                max={100}
                value={tokenStrategyN}
                onChange={(e) => setTokenStrategyN(Math.max(1, Number(e.target.value)))}
              />
              <span className="text-sm text-slate-300">entradas</span>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Com múltiplos tokens, a rotação distribui o uso entre eles. Requer ao menos 2 tokens conectados para funcionar.
        </p>
      </Section>

      <Section title="Nomes a evitar (Anti-Concorrência)">
        <textarea
          className="input font-mono text-sm resize-none h-28"
          placeholder={"ALANA\nMARIA\nSOPHIA\nLANA"}
          value={blockedNames}
          onChange={(e) => setBlockedNames(e.target.value)}
          spellCheck={false}
        />
        <p className="text-xs text-slate-500 mt-2">
          Um nome por linha. Quando a fila exibir o nome de um jogador que esteja nessa lista, o bot pula a fila automaticamente (sem clicar Entrar). Funciona apenas para filas que mostram nomes — filas que só exibem IDs são ignoradas.
        </p>
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
        <div className="flex gap-2 flex-wrap">
          {instanceId !== 1 && (
            <button
              onClick={handleImportFromBot1}
              className="btn-secondary"
              title="Copia toda a configuração do BOT1 para este bot (sem tokens)"
            >
              <ImportIcon className="w-3.5 h-3.5" />
              Importar config do BOT1
            </button>
          )}
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
  onPriorityChange,
  onClearChannels,
  onMatchTypeChange,
  detectedMatchType,
  expanded,
}: {
  org: Org;
  mode: "normal" | "delete";
  checked: boolean;
  markedForDelete: boolean;
  onToggle: () => void;
  onToggleDelete: () => void;
  onShowChannels: () => void;
  onPriorityChange: (p: number) => void;
  onClearChannels: () => void;
  onMatchTypeChange: (t: string) => void;
  detectedMatchType?: string | null;
  expanded: boolean;
}) {
  const [channels, setChannels] = useState<OrgChannel[] | null>(null);
  const [editingPriority, setEditingPriority] = useState(false);
  const [priorityDraft, setPriorityDraft] = useState(String(org.priority ?? 1));
  const [clearing, setClearing] = useState(false);

  function savePriority() {
    const v = parseInt(priorityDraft, 10);
    if (!isNaN(v) && v > 0) onPriorityChange(v);
    else setPriorityDraft(String(org.priority ?? 1));
    setEditingPriority(false);
  }

  // Invalida o cache sempre que o servidor reportar uma contagem diferente
  useEffect(() => {
    setChannels(null);
  }, [org.channels_count]);

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
        {/* Badge de tipo de partida + dropdown de edição */}
        {mode === "normal" && (() => {
          const mt = (org.match_type ?? "thread") as MatchType;
          const b = MATCH_TYPE_BADGES[mt];
          const mismatch =
            detectedMatchType &&
            detectedMatchType !== mt &&
            mt !== "mixed";
          return (
            <span className="flex items-center gap-1">
              <select
                value={mt}
                onChange={(e) => onMatchTypeChange(e.target.value)}
                title="Tipo de partida desta org"
                className={`text-[10px] px-1.5 py-0.5 rounded-full ring-1 cursor-pointer font-medium ${b.cls}`}
                style={{ background: "transparent", border: "none", outline: "none", appearance: "none" }}
              >
                <option value="thread">📍 thread</option>
                <option value="private_channel">📺 private</option>
                <option value="mixed">🔀 mixed</option>
              </select>
              {mismatch && (
                <span
                  title={`Detectado: ${detectedMatchType} (diferente do configurado: ${mt})`}
                  className="text-[9px] font-bold text-amber-400 ring-1 ring-amber-400/40 bg-amber-400/10 px-1 py-0.5 rounded cursor-help"
                >
                  ≠{detectedMatchType === "thread" ? "📍" : "📺"}
                </span>
              )}
            </span>
          );
        })()}
        {org.guild_id ? (
          <span className="text-[10px] text-slate-500 font-mono">
            {org.guild_id.slice(0, 6)}…{org.guild_id.slice(-4)}
          </span>
        ) : (
          <span className="text-[10px] text-rose-400/80 uppercase tracking-wider">
            sem guild_id
          </span>
        )}
        {mode === "normal" && (
          editingPriority ? (
            <input
              type="number"
              min={1}
              max={99}
              autoFocus
              className="w-10 rounded px-1 py-0.5 text-center text-xs outline-none"
              style={{ background: "#0f172a", border: "1px solid rgba(251,146,60,0.5)", color: "#e2e8f0" }}
              value={priorityDraft}
              onChange={(e) => setPriorityDraft(e.target.value)}
              onBlur={savePriority}
              onKeyDown={(e) => { if (e.key === "Enter") savePriority(); if (e.key === "Escape") { setPriorityDraft(String(org.priority ?? 1)); setEditingPriority(false); } }}
            />
          ) : (
            <button
              type="button"
              title="Clique para editar prioridade"
              onClick={() => { setPriorityDraft(String(org.priority ?? 1)); setEditingPriority(true); }}
              className="text-[10px] px-1.5 py-0.5 rounded font-mono tabular-nums"
              style={{ background: "rgba(255,255,255,0.05)", color: "#64748b", border: "1px solid rgba(255,255,255,0.08)" }}
            >
              P{org.priority ?? 1}
            </button>
          )
        )}
        <span className="ml-auto flex items-center gap-2">
          {(org.channels_count ?? 0) > 0 && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={onShowChannels}
                className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30 hover:bg-emerald-400/20"
              >
                {org.channels_count} {(org.channels_count ?? 0) === 1 ? "fila" : "filas"}
              </button>
              <button
                type="button"
                title="Excluir filas desta org (a próxima inicialização do bot irá re-varrer)"
                disabled={clearing}
                onClick={async () => {
                  if (!confirm(`Excluir todas as ${org.channels_count} filas de "${org.name}"? O bot vai re-varrer no próximo start.`)) return;
                  setClearing(true);
                  try {
                    await api(`/api/orgs/${org.id}/channels`, { method: "DELETE" });
                    setChannels(null);
                    onClearChannels();
                  } finally {
                    setClearing(false);
                  }
                }}
                className="w-5 h-5 flex items-center justify-center rounded text-rose-400/70 hover:text-rose-300 hover:bg-rose-400/10 disabled:opacity-40 transition-colors"
              >
                {clearing ? (
                  <svg viewBox="0 0 24 24" className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor">
                    <path d="M9 3h6l1 1h4v2H4V4h4L9 3zM5 7h14l-1 13H6L5 7zm4 2v9h1V9H9zm4 0v9h1V9h-1z" />
                  </svg>
                )}
              </button>
            </span>
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
    ok: { label: "conectado", cls: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30" },
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
function EyeIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function SpinnerIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  );
}
function RefreshIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 4v6h6M23 20v-6h-6" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
    </svg>
  );
}
