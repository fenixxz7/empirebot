import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool, query } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


export async function initDatabase(): Promise<void> {
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);

  // Garante colunas de orgs necessárias antes de qualquer query que as use
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS discovery_blocked BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE`,
  );

  // Migrações idempotentes para bancos antigos
  await pool.query(
    `ALTER TABLE org_channels ADD COLUMN IF NOT EXISTS application_id TEXT`,
  );
  // Permite categorias livres (Mobile, Misto, Emulador, Tatico, Full-Soco, etc.)
  await pool.query(
    `ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_category_check`,
  );
  await pool.query(
    `ALTER TABLE instance_configs DROP CONSTRAINT IF EXISTS instance_configs_category_check`,
  );
  // allowed_categories: novo campo multi-categoria (substitui o "category" único)
  await pool.query(
    `ALTER TABLE instance_configs
     ADD COLUMN IF NOT EXISTS allowed_categories TEXT NOT NULL DEFAULT 'Mobile'`,
  );
  // Timing configurável (substitui constantes hardcoded do engine)
  await pool.query(`ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS timing_intra_min_ms INTEGER NOT NULL DEFAULT 4000`);
  await pool.query(`ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS timing_intra_max_ms INTEGER NOT NULL DEFAULT 7000`);
  await pool.query(`ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS timing_pause_min_ms INTEGER NOT NULL DEFAULT 25000`);
  await pool.query(`ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS timing_pause_max_ms INTEGER NOT NULL DEFAULT 35000`);
  await pool.query(`ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS timing_click_min_ms INTEGER NOT NULL DEFAULT 1000`);
  await pool.query(`ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS timing_click_max_ms INTEGER NOT NULL DEFAULT 2000`);
  // Categoria por canal e título do embed (pra distinguir múltiplas filas no log)
  await pool.query(
    `ALTER TABLE org_channels ADD COLUMN IF NOT EXISTS category TEXT`,
  );
  await pool.query(
    `ALTER TABLE org_channels ADD COLUMN IF NOT EXISTS embed_title TEXT`,
  );
  await pool.query(
    `ALTER TABLE org_channels ADD COLUMN IF NOT EXISTS embed_valor TEXT`,
  );
  // Cada canal pode ter VÁRIAS filas (mensagens) — chave única vira (org, canal, msg)
  await pool.query(
    `ALTER TABLE org_channels ALTER COLUMN message_id SET DEFAULT ''`,
  );
  await pool.query(
    `UPDATE org_channels SET message_id = '' WHERE message_id IS NULL`,
  );
  await pool.query(
    `ALTER TABLE org_channels ALTER COLUMN message_id SET NOT NULL`,
  );
  await pool.query(
    `ALTER TABLE org_channels DROP CONSTRAINT IF EXISTS org_channels_org_id_channel_id_key`,
  );
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'org_channels_org_id_channel_id_message_id_key'
      ) THEN
        ALTER TABLE org_channels
          ADD CONSTRAINT org_channels_org_id_channel_id_message_id_key
          UNIQUE (org_id, channel_id, message_id);
      END IF;
    END $$;
  `);
  // active_queues também ganha message_id na chave única
  await pool.query(
    `ALTER TABLE active_queues ADD COLUMN IF NOT EXISTS message_id TEXT NOT NULL DEFAULT ''`,
  );
  await pool.query(
    `ALTER TABLE active_queues ADD COLUMN IF NOT EXISTS category TEXT`,
  );
  await pool.query(
    `ALTER TABLE active_queues ADD COLUMN IF NOT EXISTS joined_with_players BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE active_queues DROP CONSTRAINT IF EXISTS active_queues_instance_id_channel_id_key`,
  );
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'active_queues_instance_id_channel_id_message_id_key'
      ) THEN
        ALTER TABLE active_queues
          ADD CONSTRAINT active_queues_instance_id_channel_id_message_id_key
          UNIQUE (instance_id, channel_id, message_id);
      END IF;
    END $$;
  `);

  // Wipe único: dados antigos tinham 1 row por canal sem categoria detectada.
  // O modelo novo é 1 row por mensagem com categoria por canal — força um
  // rediscovery limpo.
  const wipeNeeded = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM org_channels WHERE category IS NULL`,
  );
  if (Number(wipeNeeded.rows[0]?.n ?? "0") > 0) {
    await pool.query(`DELETE FROM org_channels`);
    // Reseta last_discovered_at para forçar rediscovery após o wipe
    await pool.query(`UPDATE orgs SET last_discovered_at = NULL`);
  }

  // Garante que orgs sem nenhum canal cadastrado sejam redescobertos no próximo start.
  // Isso corrige o caso em que o servidor reinicia (VPS/Replit), org_channels é perdida
  // mas last_discovered_at ainda está preenchido — bloqueando a descoberta automática.
  await pool.query(`
    UPDATE orgs SET last_discovered_at = NULL
    WHERE last_discovered_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM org_channels oc WHERE oc.org_id = orgs.id
      )
  `);

  // Migração: tabela de partidas detectadas (Fase 9/10)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id            BIGSERIAL PRIMARY KEY,
      instance_id   INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      channel_id    TEXT NOT NULL,
      channel_name  TEXT,
      guild_id      TEXT,
      org_id        INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
      org_name      TEXT,
      mode          TEXT,
      category      TEXT,
      embed_valor   TEXT,
      adversary_id  TEXT,
      msg_sent      BOOLEAN NOT NULL DEFAULT FALSE,
      detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (instance_id, channel_id)
    )
  `);

  // Histórico de entradas por org (para estatísticas por período)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS queue_joins (
      id          BIGSERIAL PRIMARY KEY,
      instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      org_id      INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
      org_name    TEXT,
      mode        TEXT,
      category    TEXT,
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS queue_joins_instance_joined
      ON queue_joins (instance_id, joined_at DESC)
  `);

  // Nomes bloqueados (evitar entrar em fila com esses oponentes)
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS blocked_names TEXT NOT NULL DEFAULT ''`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS match_msg_delay_ms INTEGER NOT NULL DEFAULT 0`,
  );
  // Valor máximo de entrada (R$0 = sem limite)
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS max_valor NUMERIC(10,2) NOT NULL DEFAULT 0`,
  );
  // Estratégia de rotação de tokens: single | per_n_orgs | full_cycle
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS token_strategy TEXT NOT NULL DEFAULT 'single'`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS token_strategy_n INTEGER NOT NULL DEFAULT 5`,
  );
  // Contador de filas puladas por nome bloqueado
  await pool.query(
    `ALTER TABLE stats ADD COLUMN IF NOT EXISTS bloqueadas INTEGER NOT NULL DEFAULT 0`,
  );
  // Contador de mensagens enviadas com sucesso nas partidas
  await pool.query(
    `ALTER TABLE stats ADD COLUMN IF NOT EXISTS msgs_enviadas INTEGER NOT NULL DEFAULT 0`,
  );
  // Delay aleatório de mensagem de partida: intervalo [min, max]
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS match_msg_delay_min_ms INTEGER NOT NULL DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS match_msg_delay_max_ms INTEGER NOT NULL DEFAULT 0`,
  );
  // match_send_errors: código de erro do Discord + última mensagem (diagnóstico)
  await pool.query(
    `ALTER TABLE match_send_errors ADD COLUMN IF NOT EXISTS last_error_code INTEGER`,
  );
  await pool.query(
    `ALTER TABLE match_send_errors ADD COLUMN IF NOT EXISTS last_message TEXT`,
  );
  // Overrides de mensagem por org (auto-sanitizadas após N bloqueios de AutoMod)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_message_overrides (
      instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      org_key         TEXT NOT NULL,
      message         TEXT NOT NULL,
      source          TEXT NOT NULL DEFAULT 'auto',
      automod_blocks  INTEGER NOT NULL DEFAULT 0,
      generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (instance_id, org_key)
    )
  `);
  // Sincroniza contador msgs_enviadas com a verdade do banco (matches.msg_sent)
  // — inclui instâncias sem matches (resetadas para 0) via LEFT JOIN.
  await pool.query(`
    UPDATE stats s
       SET msgs_enviadas = COALESCE(m.n, 0)
      FROM (
        SELECT i.id AS instance_id, COUNT(mm.id)::int AS n
          FROM instances i
          LEFT JOIN matches mm
            ON mm.instance_id = i.id AND mm.msg_sent = TRUE
         GROUP BY i.id
      ) m
     WHERE m.instance_id = s.instance_id
  `);

  // Discovery bloqueada permanentemente por erro de acesso/ban (ex: código 50001)
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS discovery_blocked BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  // Timestamp da última varredura bem-sucedida de canais (NULL = nunca varrida ou explicitamente limpa)
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ`,
  );

  // Orgs inválidas por token — ban, sem acesso, timeout de guild
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_org_blacklist (
      token_id   INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      org_id     INTEGER NOT NULL REFERENCES orgs(id)   ON DELETE CASCADE,
      reason     TEXT,
      blocked_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (token_id, org_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS token_org_blacklist_token
      ON token_org_blacklist (token_id)
  `);

  // ── DM Responder ─────────────────────────────────────────────────────────
  // Mensagens a enviar nos message requests recebidos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_messages (
      id          SERIAL PRIMARY KEY,
      instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      name        TEXT    NOT NULL DEFAULT '',
      body        TEXT    NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Configuração do DM responder por instância
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_config (
      instance_id      INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
      enabled          BOOLEAN NOT NULL DEFAULT FALSE,
      min_delay_msg    REAL    NOT NULL DEFAULT 1.5,
      max_delay_msg    REAL    NOT NULL DEFAULT 2.5,
      min_delay_user   REAL    NOT NULL DEFAULT 10,
      max_delay_user   REAL    NOT NULL DEFAULT 15
    )
  `);
  // Usuários já respondidos (evita responder duas vezes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_responded (
      instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      user_id     TEXT    NOT NULL,
      responded_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (instance_id, user_id)
    )
  `);
  // Seed dm_config para todas as instâncias existentes
  await pool.query(`
    INSERT INTO dm_config (instance_id)
    SELECT id FROM instances
    ON CONFLICT (instance_id) DO NOTHING
  `);

  // ── Pool global de tokens ─────────────────────────────────────────────────
  // Token pool: tokens registrados globalmente, selecionáveis por instância
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_pool (
      id           SERIAL PRIMARY KEY,
      value        TEXT UNIQUE NOT NULL,
      label        TEXT,
      status       TEXT NOT NULL DEFAULT 'unknown',
      username     TEXT,
      last_used_at TIMESTAMPTZ
    )
  `);
  // Seleção de tokens por instância (substitui tokens_raw)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instance_token_selection (
      instance_id   INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      token_pool_id INTEGER NOT NULL REFERENCES token_pool(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance_id, token_pool_id)
    )
  `);
  // Migra tokens existentes para o pool global (compatibilidade com bancos antigos)
  await pool.query(`
    INSERT INTO token_pool (value, status, username)
    SELECT DISTINCT value, status, username FROM tokens
    ON CONFLICT (value) DO NOTHING
  `);
  // Popula instance_token_selection com a seleção atual de cada instância
  await pool.query(`
    INSERT INTO instance_token_selection (instance_id, token_pool_id, position)
    SELECT t.instance_id, tp.id, t.position
    FROM tokens t
    JOIN token_pool tp ON tp.value = t.value
    ON CONFLICT DO NOTHING
  `);

  // Senhas de acesso temporárias (multi-usuário)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id             SERIAL PRIMARY KEY,
      label          TEXT NOT NULL,
      password       TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      force_logout_at TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE access_keys ADD COLUMN IF NOT EXISTS force_logout_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE access_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);

  // Histórico de logins por chave de acesso
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_key_logins (
      id            SERIAL PRIMARY KEY,
      access_key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
      ip            TEXT NOT NULL,
      logged_in_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Log de auditoria de ações administrativas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id               SERIAL PRIMARY KEY,
      action           TEXT NOT NULL,
      access_key_label TEXT,
      access_key_id    INTEGER,
      ip               TEXT,
      detail           TEXT,
      performed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Orgs por instância: adiciona instance_id e remove unique global de guild_id
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE`,
  );
  // Preenche orgs existentes com a instância associada via instance_orgs
  await pool.query(`
    UPDATE orgs SET instance_id = (
      SELECT io.instance_id FROM instance_orgs io WHERE io.org_id = orgs.id LIMIT 1
    ) WHERE instance_id IS NULL AND EXISTS (
      SELECT 1 FROM instance_orgs io WHERE io.org_id = orgs.id
    )
  `);
  // Remove constraint UNIQUE global de guild_id (permite mesmo guild em instâncias distintas)
  await pool.query(`ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_guild_id_key`);

  // Rate limit por org: após N cliques, avança para próxima org
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS clicks_per_org INTEGER NOT NULL DEFAULT 10`,
  );

  // Caps de entradas por janela de 60s (configuráveis pelo painel)
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS entry_cap_with_players_per_60s INTEGER NOT NULL DEFAULT 30`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS entry_cap_empty_per_60s INTEGER NOT NULL DEFAULT 18`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS entry_cap_total_per_60s INTEGER NOT NULL DEFAULT 48`,
  );

  // Garante que ninguém ficou com fila "fantasma" entre boots
  await pool.query(`DELETE FROM active_queues`);

  for (const botName of ["BOT1", "BOT2"]) {
    const instances = await query<{ id: number }>(
      `INSERT INTO instances (name, running)
       VALUES ($1, FALSE)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [botName]
    );
    const instanceId = instances[0]!.id;

    await query(
      `INSERT INTO instance_configs (instance_id) VALUES ($1)
       ON CONFLICT (instance_id) DO NOTHING`,
      [instanceId]
    );

    await query(
      `INSERT INTO stats (instance_id) VALUES ($1)
       ON CONFLICT (instance_id) DO NOTHING`,
      [instanceId]
    );
  }

  // Separar "org conhecida" de "org selecionada" — presença na tabela = conhecida, coluna = ativa
  await pool.query(
    `ALTER TABLE instance_orgs ADD COLUMN IF NOT EXISTS selected BOOLEAN NOT NULL DEFAULT TRUE`,
  );

  // Delay configurável da verificação de recusa pós-clique (async, não bloqueia ciclo)
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS refusal_check_delay_ms INTEGER NOT NULL DEFAULT 800`,
  );

}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  initDatabase()
    .then(() => {
      console.log("DB initialized");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
