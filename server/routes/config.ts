import { Router } from "express";
import { query } from "../db/pool.js";
import { manager } from "../worker/manager.js";
import {
  runAutoDiscoveryForInstance,
  type DiscoveryResult,
} from "../discord/discovery.js";

export const configRouter = Router();

function preview(token: string): string {
  if (!token) return "";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

configRouter.get("/:instanceId", async (req, res) => {
  const id = Number(req.params.instanceId);

  const cfg = await query<{
    category: string; allowed_categories: string;
    delay_seconds: number; rotation_minutes: number;
    allowed_modes: string; message_main: string; message_per_org: string;
    image_url: string | null;
  }>(
    `SELECT category, allowed_categories, delay_seconds, rotation_minutes,
            allowed_modes, message_main, message_per_org, image_url
     FROM instance_configs WHERE instance_id = $1`,
    [id]
  );

  const tokens = await query<{
    id: number; position: number; value: string; status: string; username: string | null;
  }>(
    `SELECT id, position, value, status, username
     FROM tokens WHERE instance_id = $1
     ORDER BY position ASC`,
    [id]
  );

  const selectedOrgs = await query<{ org_id: number }>(
    `SELECT org_id FROM instance_orgs WHERE instance_id = $1`,
    [id]
  );

  res.json({
    config: cfg[0] ?? null,
    tokens: tokens.map((t) => ({
      id: t.id,
      position: t.position,
      value_preview: preview(t.value),
      status: t.status,
      username: t.username,
    })),
    selected_org_ids: selectedOrgs.map((r) => r.org_id),
  });
});

const VALID_CATEGORIES = ["Mobile", "Misto", "Emulador", "Tatico", "Full-Soco"];

configRouter.put("/:instanceId", async (req, res) => {
  const id = Number(req.params.instanceId);
  const {
    allowed_categories, delay_seconds, rotation_minutes,
    allowed_modes, message_main, message_per_org, image_url,
    tokens_raw, selected_org_ids,
  } = req.body as {
    allowed_categories: string | string[];
    delay_seconds: number;
    rotation_minutes: number;
    allowed_modes: string;
    message_main: string;
    message_per_org: string;
    image_url: string | null;
    tokens_raw: string;
    selected_org_ids: number[];
  };

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

  await query(
    `UPDATE instance_configs
     SET category = $2, allowed_categories = $3,
         delay_seconds = $4, rotation_minutes = $5,
         allowed_modes = $6, message_main = $7, message_per_org = $8,
         image_url = $9, updated_at = NOW()
     WHERE instance_id = $1`,
    [id, primaryCategory, allowedCategoriesStr,
     delay_seconds, rotation_minutes, allowed_modes,
     message_main, message_per_org, image_url ?? null]
  );

  // Tokens: aceitamos textarea (1 por linha). Vazio = mantém os que estão.
  const lines = (tokens_raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length > 0) {
    if (lines.length > 5) {
      return res.status(400).json({ error: "Máximo de 5 tokens" });
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

  // Orgs selecionadas
  if (Array.isArray(selected_org_ids)) {
    await query(`DELETE FROM instance_orgs WHERE instance_id = $1`, [id]);
    for (const orgId of selected_org_ids) {
      await query(
        `INSERT INTO instance_orgs (instance_id, org_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, orgId]
      );
    }
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
    const tokensRows = await query<{ value: string }>(
      `SELECT value FROM tokens
       WHERE instance_id = $1 AND status = 'connected'
       ORDER BY position ASC LIMIT 1`,
      [id],
    );
    const token = tokensRows[0]?.value;
    if (!token) {
      discovery_skipped =
        "Sem token conectado — a descoberta vai rodar automaticamente quando o bot iniciar.";
    } else {
      discovery = await runAutoDiscoveryForInstance(id, token);
    }
  }

  res.json({ ok: true, discovery, discovery_skipped });
});

// Export: devolve JSON com toda a configuração da instância
configRouter.get("/:instanceId/export", async (req, res) => {
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

  const orgs = await query<{ org_id: number; org_name: string; guild_id: string | null }>(
    `SELECT io.org_id, o.name AS org_name, o.guild_id
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
});

// Import: recebe JSON exportado e reaplica configuração (sem tokens)
configRouter.post("/:instanceId/import", async (req, res) => {
  const id = Number(req.params.instanceId);
  const body = req.body as {
    version?: number;
    config?: {
      allowed_categories?: string;
      delay_seconds?: number;
      rotation_minutes?: number;
      allowed_modes?: string;
      message_main?: string;
      message_per_org?: string;
      image_url?: string | null;
    };
    selected_orgs?: { org_id: number }[];
  };

  if (!body?.config) {
    return res.status(400).json({ error: "JSON inválido — campo 'config' ausente." });
  }

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
    await query(`DELETE FROM instance_orgs WHERE instance_id = $1`, [id]);
    for (const o of body.selected_orgs) {
      await query(
        `INSERT INTO instance_orgs (instance_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
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
});
