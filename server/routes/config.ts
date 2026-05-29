import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { manager } from "../worker/manager.js";
import {
  runAutoDiscoveryForInstance,
  type DiscoveryResult,
} from "../discord/discovery.js";
import { validate } from "../lib/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const configRouter = Router();

// Body do PUT /:instanceId — validação tolerante.
// Mantemos o comportamento original do código (que ignorava silenciosamente
// arrays malformados via `Array.isArray(...)`) — então arrays usam .catch([])
// pra não quebrar requests legados que passam null/undefined/garbage.
const TolerantIntArray = z
  .array(z.coerce.number().int())
  .optional()
  .catch(undefined);

const SaveConfigBody = z.object({
  allowed_categories: z.union([z.string(), z.array(z.string())]),
  delay_seconds: z.coerce.number().min(0),
  rotation_minutes: z.coerce.number().min(0),
  allowed_modes: z.string(),
  message_main: z.string(),
  message_per_org: z.string(),
  image_url: z.string().nullable().optional(),
  tokens_raw: z.string().optional().default(""),
  selected_org_ids: TolerantIntArray,
  selected_token_ids: TolerantIntArray,
  blocked_names: z.string().optional().default(""),
  max_valor: z.coerce.number().default(0),
  token_strategy: z.string().optional().default("single"),
  token_strategy_n: z.coerce.number().int().min(1).optional().default(5),
  timing_intra_min_ms: z.coerce.number().int().min(500).optional().default(4000),
  timing_intra_max_ms: z.coerce.number().int().min(500).optional().default(7000),
  timing_pause_min_ms: z.coerce.number().int().min(1000).optional().default(25000),
  timing_pause_max_ms: z.coerce.number().int().min(1000).optional().default(35000),
  timing_click_min_ms: z.coerce.number().int().min(100).optional().default(1000),
  timing_click_max_ms: z.coerce.number().int().min(100).optional().default(2000),
  clicks_per_org: z.coerce.number().int().min(0).optional().default(10),
  hot_org_extra_clicks: z.coerce.number().int().min(0).max(50).optional().default(10),
  match_msg_delay_ms: z.coerce.number().int().min(0).optional().default(0),
  match_msg_delay_min_ms: z.coerce.number().int().min(0).optional().default(0),
  match_msg_delay_max_ms: z.coerce.number().int().min(0).optional().default(0),
  entry_cap_with_players_per_60s: z.coerce.number().int().min(0).max(200).optional().default(30),
  entry_cap_empty_per_60s: z.coerce.number().int().min(0).max(200).optional().default(18),
  entry_cap_total_per_60s: z.coerce.number().int().min(0).max(200).optional().default(48),
  refusal_check_delay_ms: z.coerce.number().int().min(300).max(5000).optional().default(800),
  enable_60rpm_mode: z.boolean().optional().default(false),
  active_queue_soft_limit: z.coerce.number().int().min(10).max(1000).optional().default(120),
  active_queue_hard_limit: z.coerce.number().int().min(10).max(1000).optional().default(180),
  optimize_for_conversion: z.boolean().optional().default(false),
  only_empty_queues: z.boolean().optional().default(false),
});

// Body do POST /:instanceId/import — formato JSON exportado.
const ImportConfigBody = z.object({
  version: z.number().optional(),
  config: z.object({
    allowed_categories: z.string().optional(),
    delay_seconds: z.coerce.number().optional(),
    rotation_minutes: z.coerce.number().optional(),
    allowed_modes: z.string().optional(),
    message_main: z.string().optional(),
    message_per_org: z.string().optional(),
    image_url: z.string().nullable().optional(),
  }, { error: "JSON inválido — campo 'config' ausente." }),
  selected_orgs: z
    .array(z.object({
      org_id: z.coerce.number().int(),
      org_name: z.string().optional(),
      guild_id: z.string().nullable().optional(),
      priority: z.coerce.number().int().optional(),
    }))
    .optional()
    .catch(undefined),
});

function preview(token: string): string {
  if (!token) return "";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

configRouter.get("/:instanceId", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);

  const cfg = await query<{
    category: string; allowed_categories: string;
    delay_seconds: number; rotation_minutes: number;
    allowed_modes: string; message_main: string; message_per_org: string;
    image_url: string | null; blocked_names: string;
    max_valor: number; token_strategy: string; token_strategy_n: number;
    timing_intra_min_ms: number; timing_intra_max_ms: number;
    timing_pause_min_ms: number; timing_pause_max_ms: number;
    timing_click_min_ms: number; timing_click_max_ms: number;
    clicks_per_org: number;
    match_msg_delay_ms: number;
    match_msg_delay_min_ms: number;
    match_msg_delay_max_ms: number;
    entry_cap_with_players_per_60s: number;
    entry_cap_empty_per_60s: number;
    entry_cap_total_per_60s: number;
    refusal_check_delay_ms: number;
    hot_org_extra_clicks: number;
    enable_60rpm_mode: boolean;
    active_queue_soft_limit: number;
    active_queue_hard_limit: number;
    optimize_for_conversion: boolean;
    only_empty_queues: boolean;
  }>(
    `SELECT category, allowed_categories, delay_seconds, rotation_minutes,
            allowed_modes, message_main, message_per_org, image_url, blocked_names,
            max_valor, token_strategy, token_strategy_n,
            timing_intra_min_ms, timing_intra_max_ms,
            timing_pause_min_ms, timing_pause_max_ms,
            timing_click_min_ms, timing_click_max_ms,
            clicks_per_org, hot_org_extra_clicks, match_msg_delay_ms,
            match_msg_delay_min_ms, match_msg_delay_max_ms,
            entry_cap_with_players_per_60s, entry_cap_empty_per_60s,
            entry_cap_total_per_60s, refusal_check_delay_ms,
            enable_60rpm_mode, active_queue_soft_limit, active_queue_hard_limit,
            optimize_for_conversion, only_empty_queues
     FROM instance_configs WHERE instance_id = $1`,
    [id]
  );

  // Pool de tokens desta instância (apenas os selecionados para ela)
  const tokenPool = await query<{
    id: number; label: string | null; value: string; status: string; username: string | null;
  }>(
    `SELECT tp.id, tp.label, tp.value, tp.status, tp.username
     FROM token_pool tp
     INNER JOIN instance_token_selection its ON its.token_pool_id = tp.id
     WHERE its.instance_id = $1
     ORDER BY its.position ASC`,
    [id]
  );

  // IDs selecionados para esta instância
  const selectedTokens = await query<{ token_pool_id: number; position: number }>(
    `SELECT token_pool_id, position FROM instance_token_selection
     WHERE instance_id = $1 ORDER BY position ASC`,
    [id]
  );

  const selectedOrgs = await query<{ org_id: number }>(
    `SELECT org_id FROM instance_orgs WHERE instance_id = $1 AND selected = TRUE`,
    [id]
  );

  res.json({
    config: cfg[0] ?? null,
    token_pool: tokenPool.map((t) => ({
      id: t.id,
      label: t.label,
      value_preview: preview(t.value),
      status: t.status,
      username: t.username,
    })),
    selected_token_ids: selectedTokens.map((r) => r.token_pool_id),
    // legado — mantido para compatibilidade com código antigo
    tokens: selectedTokens.map((s, i) => {
      const t = tokenPool.find((p) => p.id === s.token_pool_id);
      return {
        id: s.token_pool_id,
        position: i + 1,
        value_preview: t ? preview(t.value) : "???",
        status: t?.status ?? "unknown",
        username: t?.username ?? null,
      };
    }),
    selected_org_ids: selectedOrgs.map((r) => r.org_id),
  });
}));

const VALID_CATEGORIES = ["Mobile", "Misto", "Emulador", "Tatico", "Full-Soco"];

configRouter.put("/:instanceId", validate({ body: SaveConfigBody }), asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  const {
    allowed_categories, delay_seconds, rotation_minutes,
    allowed_modes, message_main, message_per_org, image_url,
    tokens_raw, selected_org_ids, blocked_names,
    max_valor, token_strategy, token_strategy_n,
    selected_token_ids,
    timing_intra_min_ms, timing_intra_max_ms,
    timing_pause_min_ms, timing_pause_max_ms,
    timing_click_min_ms, timing_click_max_ms,
    clicks_per_org,
    hot_org_extra_clicks,
    match_msg_delay_ms,
    match_msg_delay_min_ms,
    match_msg_delay_max_ms,
    entry_cap_with_players_per_60s,
    entry_cap_empty_per_60s,
    entry_cap_total_per_60s,
    refusal_check_delay_ms,
    enable_60rpm_mode,
    active_queue_soft_limit,
    active_queue_hard_limit,
    optimize_for_conversion,
    only_empty_queues,
  } = req.body;

  // allowed_categories pode chegar como array (UI) ou string CSV (terminal/api)
  const cats = Array.isArray(allowed_categories)
    ? allowed_categories
    : String(allowed_categories ?? "")
        .split(/[\s,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  const invalid = cats.filter((c) => !VALID_CATEGORIES.includes(c));
  if (invalid.length > 0) {
    return res.status(400).json({
      error: `Categoria(s) inválida(s): ${invalid.join(", ")}. Aceitos: ${VALID_CATEGORIES.join(", ")}`,
    });
  }
  if (cats.length === 0) {
    return res.status(400).json({ error: "Selecione ao menos uma categoria." });
  }

  // Mantém a coluna `category` (single, legado) preenchida com a primeira
  // selecionada pra não quebrar consultas antigas.
  const allowedCategoriesStr = cats.join("\n");
  const primaryCategory = cats[0];

  const validStrategies = ["single", "per_n_orgs", "full_cycle"];
  const safeStrategy = validStrategies.includes(token_strategy) ? token_strategy : "single";

  await query(
    `UPDATE instance_configs
     SET category = $2, allowed_categories = $3,
         delay_seconds = $4, rotation_minutes = $5,
         allowed_modes = $6, message_main = $7, message_per_org = $8,
         image_url = $9, blocked_names = $10,
         max_valor = $11, token_strategy = $12, token_strategy_n = $13,
         timing_intra_min_ms = $14, timing_intra_max_ms = $15,
         timing_pause_min_ms = $16, timing_pause_max_ms = $17,
         timing_click_min_ms = $18, timing_click_max_ms = $19,
         clicks_per_org = $20, match_msg_delay_ms = $21,
         match_msg_delay_min_ms = $22, match_msg_delay_max_ms = $23,
         entry_cap_with_players_per_60s = $24,
         entry_cap_empty_per_60s = $25,
         entry_cap_total_per_60s = $26,
         refusal_check_delay_ms = $27,
         hot_org_extra_clicks = $28,
         enable_60rpm_mode = $29,
         active_queue_soft_limit = $30,
         active_queue_hard_limit = $31,
         optimize_for_conversion = $32,
         only_empty_queues = $33,
         updated_at = NOW()
     WHERE instance_id = $1`,
    [id, primaryCategory, allowedCategoriesStr,
     delay_seconds, rotation_minutes, allowed_modes,
     message_main, message_per_org, image_url ?? null,
     blocked_names ?? "",
     Number(max_valor ?? 0), safeStrategy, Math.max(1, Number(token_strategy_n ?? 5)),
     timing_intra_min_ms ?? 4000, timing_intra_max_ms ?? 7000,
     timing_pause_min_ms ?? 25000, timing_pause_max_ms ?? 35000,
     timing_click_min_ms ?? 1000, timing_click_max_ms ?? 2000,
     Math.max(0, Number(clicks_per_org ?? 10)),
     Math.max(0, Number(match_msg_delay_ms ?? 0)),
     Math.max(0, Number(match_msg_delay_min_ms ?? 0)),
     Math.max(0, Number(match_msg_delay_max_ms ?? 0)),
     Math.min(200, Math.max(0, Number(entry_cap_with_players_per_60s ?? 30))),
     Math.min(200, Math.max(0, Number(entry_cap_empty_per_60s ?? 18))),
     Math.min(200, Math.max(0, Number(entry_cap_total_per_60s ?? 48))),
     Math.min(5000, Math.max(300, Number(refusal_check_delay_ms ?? 800))),
     Math.min(50, Math.max(0, Number(hot_org_extra_clicks ?? 10))),
     Boolean(enable_60rpm_mode ?? false),
     Math.min(1000, Math.max(10, Number(active_queue_soft_limit ?? 120))),
     Math.min(1000, Math.max(10, Number(active_queue_hard_limit ?? 180))),
     Boolean(optimize_for_conversion ?? false),
     Boolean(only_empty_queues ?? false)]
  );

  // Tokens: novo sistema — seleção por pool ID
  if (Array.isArray(selected_token_ids)) {
    if (selected_token_ids.length > 5) {
      return res.status(400).json({ error: "Máximo de 5 tokens por instância." });
    }
    // Atualiza a tabela de seleção
    await query(`DELETE FROM instance_token_selection WHERE instance_id = $1`, [id]);
    for (let i = 0; i < selected_token_ids.length; i++) {
      await query(
        `INSERT INTO instance_token_selection (instance_id, token_pool_id, position)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, selected_token_ids[i], i + 1]
      );
    }
    // Sincroniza tabela tokens (usada pelo engine) a partir da seleção
    await query(`DELETE FROM tokens WHERE instance_id = $1`, [id]);
    if (selected_token_ids.length > 0) {
      const poolRows = await query<{ id: number; value: string; status: string }>(
        `SELECT id, value, status FROM token_pool WHERE id = ANY($1::int[]) ORDER BY id ASC`,
        [selected_token_ids]
      );
      for (let i = 0; i < selected_token_ids.length; i++) {
        const p = poolRows.find((r) => r.id === selected_token_ids[i]);
        if (p) {
          await query(
            `INSERT INTO tokens (instance_id, position, value, status)
             VALUES ($1, $2, $3, 'unknown')`,
            [id, i + 1, p.value]
          );
        }
      }
    }
  } else {
    // Fallback legado: textarea (1 token por linha)
    const lines = (tokens_raw ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      if (lines.length > 5) {
        return res.status(400).json({ error: "Máximo de 5 tokens" });
      }
      // Garante que cada token existe no pool
      for (const val of lines) {
        await query(
          `INSERT INTO token_pool (value, status) VALUES ($1, 'unknown')
           ON CONFLICT (value) DO NOTHING`,
          [val]
        );
      }
      await query(`DELETE FROM tokens WHERE instance_id = $1`, [id]);
      for (let i = 0; i < lines.length; i++) {
        await query(
          `INSERT INTO tokens (instance_id, position, value, status)
           VALUES ($1, $2, $3, 'unknown')`,
          [id, i + 1, lines[i]]
        );
      }
    }
  }

  // Orgs selecionadas — mantém todas as orgs conhecidas, apenas atualiza o flag selected
  if (Array.isArray(selected_org_ids)) {
    await query(`UPDATE instance_orgs SET selected = FALSE WHERE instance_id = $1`, [id]);
    for (const orgId of selected_org_ids) {
      await query(
        `INSERT INTO instance_orgs (instance_id, org_id, selected) VALUES ($1, $2, TRUE)
         ON CONFLICT (instance_id, org_id) DO UPDATE SET selected = TRUE`,
        [id, orgId]
      );
    }
  }

  // Atualiza rotation_minutes em memória pra próxima rotação usar o novo valor
  if (typeof rotation_minutes === "number" && rotation_minutes > 0) {
    manager.updateRotationMinutes(id, rotation_minutes);
  }

  // Se a instância estava rodando, paramos automaticamente — o operador
  // precisa religar manualmente. (UI também desabilita o botão, isso é
  // a rede de segurança caso alguém bata direto na API.)
  const inst = await query<{ running: boolean }>(
    `SELECT running FROM instances WHERE id = $1`,
    [id]
  );
  if (inst[0]?.running) {
    await query(`UPDATE instances SET running = FALSE WHERE id = $1`, [id]);
    await query(`UPDATE stats SET started_at = NULL WHERE instance_id = $1`, [id]);
    await manager.stop(id).catch((err) =>
      console.error("[manager.stop/config]", err),
    );
    await query(
      `INSERT INTO logs (instance_id, level, source, message)
       VALUES ($1, 'WARN', 'config',
         'Configuração salva com bot ativo — bot pausado, ligue novamente em "Controle".')`,
      [id]
    );
  }

  await query(
    `INSERT INTO logs (instance_id, level, source, message)
     VALUES ($1, 'INFO', 'config', 'Configuração salva')`,
    [id]
  );

  // Descoberta automática: para cada org selecionada que tenha guild_id mas
  // ainda não tenha canais cadastrados, varre agora (se houver token).
  // Quando não houver, ela roda sozinha assim que o bot conectar (manager).
  let discovery: DiscoveryResult[] = [];
  let discovery_skipped: string | null = null;

  if (Array.isArray(selected_org_ids) && selected_org_ids.length > 0) {
    const tokensRows = await query<{ id: number; value: string }>(
      `SELECT id, value FROM tokens
       WHERE instance_id = $1 AND status = 'connected'
       ORDER BY position ASC LIMIT 1`,
      [id],
    );
    const tokenId = tokensRows[0]?.id;
    const token = tokensRows[0]?.value;
    if (!token || !tokenId) {
      discovery_skipped =
        "Sem token conectado — a descoberta vai rodar automaticamente quando o bot iniciar.";
    } else {
      discovery = await runAutoDiscoveryForInstance(id, tokenId, token);
    }
  }

  res.json({ ok: true, discovery, discovery_skipped });
}));

// Export: devolve JSON com toda a configuração da instância
configRouter.get("/:instanceId/export", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);

  const cfg = await query<{
    allowed_categories: string; delay_seconds: number;
    rotation_minutes: number; allowed_modes: string;
    message_main: string; message_per_org: string; image_url: string | null;
  }>(
    `SELECT allowed_categories, delay_seconds, rotation_minutes,
            allowed_modes, message_main, message_per_org, image_url
     FROM instance_configs WHERE instance_id = $1`,
    [id],
  );

  const orgs = await query<{ org_id: number; org_name: string; guild_id: string | null; priority: number }>(
    `SELECT io.org_id, o.name AS org_name, o.guild_id, o.priority
     FROM instance_orgs io JOIN orgs o ON o.id = io.org_id
     WHERE io.instance_id = $1`,
    [id],
  );

  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    config: cfg[0] ?? {},
    selected_orgs: orgs,
  };

  res.setHeader("Content-Disposition", `attachment; filename="imperiuns-config-${id}.json"`);
  res.json(payload);
}));

// Import: recebe JSON exportado e reaplica configuração (sem tokens)
configRouter.post("/:instanceId/import", validate({ body: ImportConfigBody }), asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  const body = req.body;
  const c = body.config;
  const cats = (c.allowed_categories ?? "Mobile")
    .split(/[\s,;\n]+/).map((s: string) => s.trim()).filter(Boolean);
  const primaryCategory = cats[0] ?? "Mobile";

  await query(
    `UPDATE instance_configs
     SET category = $2, allowed_categories = $3,
         delay_seconds = $4, rotation_minutes = $5,
         allowed_modes = $6, message_main = $7, message_per_org = $8,
         image_url = $9, updated_at = NOW()
     WHERE instance_id = $1`,
    [
      id, primaryCategory, cats.join("\n"),
      c.delay_seconds ?? 12, c.rotation_minutes ?? 90,
      c.allowed_modes ?? "1x1\n3x3",
      c.message_main ?? "", c.message_per_org ?? "",
      c.image_url ?? null,
    ],
  );

  if (Array.isArray(body.selected_orgs) && body.selected_orgs.length > 0) {
    // Upsert orgs com o ID original (preserva referências entre instâncias)
    for (const o of body.selected_orgs) {
      const name = o.org_name?.trim() || `org_${o.org_id}`;
      const guildId = o.guild_id?.trim() || null;
      await query(
        `INSERT INTO orgs (id, name, guild_id, category, max_queues, enabled, priority, instance_id)
         VALUES ($1, $2, $3, 'Mobile', 5, TRUE, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET guild_id = EXCLUDED.guild_id,
               name     = EXCLUDED.name,
               priority = EXCLUDED.priority`,
        [o.org_id, name, guildId, o.priority ?? 0, id],
      );
    }
    // Garante que a sequência não conflite com IDs inseridos explicitamente
    await query(`SELECT setval('orgs_id_seq', (SELECT MAX(id) FROM orgs))`);

    await query(`UPDATE instance_orgs SET selected = FALSE WHERE instance_id = $1`, [id]);
    for (const o of body.selected_orgs) {
      await query(
        `INSERT INTO instance_orgs (instance_id, org_id, selected) VALUES ($1, $2, TRUE)
         ON CONFLICT (instance_id, org_id) DO UPDATE SET selected = TRUE`,
        [id, o.org_id],
      );
    }
  }

  await query(
    `INSERT INTO logs (instance_id, level, source, message)
     VALUES ($1, 'INFO', 'config', 'Configuração importada via arquivo JSON')`,
    [id],
  );

  res.json({ ok: true });
}));
