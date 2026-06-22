import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool, query } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


export async function initDatabase(): Promise<void> {
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  // Split and run each statement individually so IF NOT EXISTS works correctly
  // on Replit's PostgreSQL (running the whole file at once causes type conflicts)
  const statements = sql
    .split(/;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await pool.query(stmt);
  }

  // Modo eficiência de conversão
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS optimize_for_conversion BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  // Modo apenas filas vazias
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS only_empty_queues BOOLEAN NOT NULL DEFAULT FALSE`,
  );

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
  // Valor máximo para filas VAZIAS (R$0 = sem limite). Evita entrar em filas de alto
  // valor onde ninguém está esperando (ex: R$100 quando vazia).
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS max_valor_empty NUMERIC(10,2) NOT NULL DEFAULT 0`,
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
  // Usa ON CONFLICT DO NOTHING sem coluna explícita: compatível mesmo após DROP da UNIQUE(value) global.
  await pool.query(`
    INSERT INTO token_pool (value, status, username)
    SELECT DISTINCT value, status, username FROM tokens
    ON CONFLICT DO NOTHING
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

  // Modo 60rpm experimental: toggle + limites globais de active_queues
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS enable_60rpm_mode BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS active_queue_soft_limit INTEGER NOT NULL DEFAULT 120`,
  );
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS active_queue_hard_limit INTEGER NOT NULL DEFAULT 180`,
  );

  // Tipo de partida por org: thread (padrão) | private_channel | mixed
  await pool.query(
    `ALTER TABLE orgs ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'thread'`,
  );
  // Seed: orgs conhecidas como canal privado (canais aparecem rápido → TTL 5min)
  await pool.query(`
    UPDATE orgs SET match_type = 'private_channel'
    WHERE UPPER(name) IN ('TOKYO','KING','ALFA','GOLD','CORUJA','FAIT','ASTRA')
  `);
  // SHARK usa misto (tem threads E canais privados)
  await pool.query(`
    UPDATE orgs SET match_type = 'mixed'
    WHERE UPPER(name) = 'SHARK'
  `);

  // Histórico/auditoria de mudanças de match_type por org
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_match_type_history (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      old_type TEXT,
      new_type TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      origin TEXT NOT NULL DEFAULT 'panel'
    )
  `);

  // ── BOT ORG — Org Joiner ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_joiner_config (
      instance_id   INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
      token_value   TEXT,
      nopecha_key   TEXT,
      delay_min_ms  BIGINT  NOT NULL DEFAULT 300000,
      delay_max_ms  BIGINT  NOT NULL DEFAULT 720000,
      enabled       BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_queue (
      id                BIGSERIAL PRIMARY KEY,
      instance_id       INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      invite_code       TEXT    NOT NULL,
      invite_raw        TEXT    NOT NULL DEFAULT '',
      status            TEXT    NOT NULL DEFAULT 'pending',
      result_guild_id   TEXT,
      result_guild_name TEXT,
      error_reason      TEXT,
      added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at      TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS org_queue_instance_status
      ON org_queue (instance_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS org_queue_instance_added
      ON org_queue (instance_id, added_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_joiner_token_selection (
      instance_id   INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
      token_pool_id INTEGER NOT NULL REFERENCES token_pool(id) ON DELETE CASCADE
    )
  `);

  // Garante que ninguém ficou com fila "fantasma" entre boots
  await pool.query(`DELETE FROM active_queues`);

  for (const botName of ["BOT1", "BOT2", "BOT3", "BOT X"]) {
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

    await query(
      `INSERT INTO dm_config (instance_id) VALUES ($1)
       ON CONFLICT (instance_id) DO NOTHING`,
      [instanceId]
    );

    await query(
      `INSERT INTO org_joiner_config (instance_id) VALUES ($1)
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

  // Modo org quente: cliques extras quando a org ainda tem muitas filas elegíveis
  await pool.query(
    `ALTER TABLE instance_configs ADD COLUMN IF NOT EXISTS hot_org_extra_clicks INTEGER NOT NULL DEFAULT 10`,
  );

  // ── Isolamento de token por instância ─────────────────────────────────────
  // Garante que a UNIQUE constraint de token_pool.value não bloqueia tokens
  // iguais em instâncias diferentes (o isolamento real já é via
  // instance_token_selection; a global é mantida para o pool compartilhado)
  // Não há alteração de schema necessária — o isolamento é comportamental
  // (DELETE só remove da instance_token_selection da instância específica).

  // ── CONTAS — Account Manager ───────────────────────────────────────────────

  // Configuração global do sistema de contas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts_config (
      id                              INTEGER PRIMARY KEY DEFAULT 1,
      max_active                      INTEGER   NOT NULL DEFAULT 10,
      min_health_score                INTEGER   NOT NULL DEFAULT 40,
      max_continuous_ms               BIGINT    NOT NULL DEFAULT 7200000,
      min_use_ms                      BIGINT,
      max_use_ms                      BIGINT,
      auto_time_mode                  BOOLEAN   NOT NULL DEFAULT TRUE,
      cooldown_after_use_ms           BIGINT    NOT NULL DEFAULT 2700000,
      cooldown_after_fail_ms          BIGINT    NOT NULL DEFAULT 1800000,
      quarantine_ms                   BIGINT    NOT NULL DEFAULT 3600000,
      health_check_interval_ms        BIGINT    NOT NULL DEFAULT 30000,
      session_validation_interval_ms  BIGINT    NOT NULL DEFAULT 120000,
      token_validation_interval_ms    BIGINT    NOT NULL DEFAULT 300000,
      reauth_preventive_ms            BIGINT    NOT NULL DEFAULT 21600000,
      auto_rotation                   BOOLEAN   NOT NULL DEFAULT TRUE,
      auto_refresh                    BOOLEAN   NOT NULL DEFAULT TRUE,
      auto_relogin                    BOOLEAN   NOT NULL DEFAULT FALSE,
      rotation_strategy               TEXT      NOT NULL DEFAULT 'weighted_health',
      CHECK (id = 1)
    )
  `);

  // Seed config padrão se não existir
  await pool.query(`
    INSERT INTO accounts_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  `);

  // Tabela principal de contas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                   SERIAL PRIMARY KEY,
      nickname             TEXT    NOT NULL,
      email                TEXT,
      password             TEXT,
      token_value          TEXT,
      token_pool_id        INTEGER REFERENCES token_pool(id) ON DELETE SET NULL,
      instance_id          INTEGER REFERENCES instances(id)  ON DELETE SET NULL,
      session_data         JSONB,
      cookies              JSONB,
      state                TEXT    NOT NULL DEFAULT 'STANDBY',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      failure_count        INTEGER NOT NULL DEFAULT 0,
      rotation_count       INTEGER NOT NULL DEFAULT 0,
      auto_rotation        BOOLEAN NOT NULL DEFAULT TRUE,
      auto_refresh         BOOLEAN NOT NULL DEFAULT TRUE,
      auto_relogin         BOOLEAN NOT NULL DEFAULT FALSE,
      min_use_ms           BIGINT,
      max_use_ms           BIGINT,
      auto_time_mode       BOOLEAN NOT NULL DEFAULT TRUE,
      activated_at         TIMESTAMPTZ,
      last_active_at       TIMESTAMPTZ,
      last_rotation_at     TIMESTAMPTZ,
      last_login_at        TIMESTAMPTZ,
      last_token_refresh_at TIMESTAMPTZ,
      cooldown_until       TIMESTAMPTZ,
      quarantine_until     TIMESTAMPTZ,
      account_lock         BOOLEAN   NOT NULL DEFAULT FALSE,
      locked_by_instance   INTEGER   REFERENCES instances(id) ON DELETE SET NULL,
      locked_at            TIMESTAMPTZ,
      lock_expires_at      TIMESTAMPTZ,
      notes                TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migrações idempotentes para accounts já existentes
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS token_value TEXT`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_lock BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_by_instance INTEGER REFERENCES instances(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lock_expires_at TIMESTAMPTZ`);

  // Logs operacionais das contas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_logs (
      id          BIGSERIAL PRIMARY KEY,
      account_id  INTEGER REFERENCES accounts(id)  ON DELETE CASCADE,
      instance_id INTEGER REFERENCES instances(id) ON DELETE SET NULL,
      event_type  TEXT    NOT NULL,
      detail      TEXT,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS account_logs_account_ts
      ON account_logs (account_id, ts DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS account_logs_ts
      ON account_logs (ts DESC)
  `);

  // ── Auto-Rotação — histórico de rotações ───────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_history (
      id              BIGSERIAL PRIMARY KEY,
      instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      old_account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      new_account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      reason          TEXT NOT NULL,
      result          TEXT NOT NULL,
      detail          TEXT,
      rotated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rotation_history_instance_ts
      ON rotation_history (instance_id, rotated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rotation_history_ts
      ON rotation_history (rotated_at DESC)
  `);

  // ── Anti-pingpong persistente ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_memory (
      id              BIGSERIAL PRIMARY KEY,
      instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotation_reason TEXT,
      rotation_result TEXT
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rotation_memory_inst_used
      ON rotation_memory (instance_id, used_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rotation_memory_acc_used
      ON rotation_memory (account_id, used_at DESC)
  `);

  // ── Alertas do Watchdog ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchdog_alerts (
      id          BIGSERIAL PRIMARY KEY,
      instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE,
      alert_type  TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'warn',
      detail      TEXT,
      resolved    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS watchdog_alerts_ts
      ON watchdog_alerts (created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS watchdog_alerts_open
      ON watchdog_alerts (resolved, created_at DESC)
  `);

  // ── Novas colunas de sistema em accounts_config ─────────────────────────────
  await pool.query(`
    ALTER TABLE accounts_config
      ADD COLUMN IF NOT EXISTS emergency_mode          BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS readonly_recovery_mode  BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS rotation_paused         BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS smart_cooldown          BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS stability_weight        INTEGER NOT NULL DEFAULT 20
  `);

  // ── match_key: identidade única de partida (suporta canais reciclados) ──────
  // Canais reciclados = mesmo channel_id pode hospedar múltiplas partidas.
  // match_key = channel_id quando é canal novo (sem last_message_id),
  // match_key = channel_id:last_message_id quando canal é reutilizado.
  // Backfill: linhas antigas usam apenas channel_id como match_key.
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS trigger_msg_id TEXT`);
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_key TEXT`);
  await pool.query(`UPDATE matches SET match_key = channel_id WHERE match_key IS NULL`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'matches_instance_match_key_key'
      ) THEN
        ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_instance_id_channel_id_key;
        ALTER TABLE matches ADD CONSTRAINT matches_instance_match_key_key
          UNIQUE (instance_id, match_key);
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_matches_instance_channel
      ON matches (instance_id, channel_id)
  `);

  // Separação de pools: tokens do Bot Fila (type='fila') vs Bot Org (type='org')
  await pool.query(`ALTER TABLE token_pool ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'fila'`);

  // Isolamento de tokens por instância no Bot Org — cada passo protegido.
  console.log("[init] migrando owner_instance_id em token_pool...");
  try {
    await pool.query(`ALTER TABLE token_pool ADD COLUMN IF NOT EXISTS owner_instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE`);
    console.log("[init] owner_instance_id ok");
  } catch (e) {
    console.warn("[init] ADD COLUMN owner_instance_id falhou (pode já existir ou conflito de FK):", (e as Error).message);
  }

  // Remove constraint UNIQUE global antiga (value) para permitir mesmo token em instâncias distintas.
  try {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_pool_value_key') THEN
          ALTER TABLE token_pool DROP CONSTRAINT token_pool_value_key;
        END IF;
      END $$
    `);
    console.log("[init] DROP CONSTRAINT token_pool_value_key ok");
  } catch (e) {
    console.warn("[init] DROP CONSTRAINT token_pool_value_key falhou:", (e as Error).message);
  }

  // Unique parcial para tokens de fila.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS token_pool_fila_value_unique
        ON token_pool (value) WHERE type = 'fila'
    `);
    console.log("[init] índice token_pool_fila_value_unique ok");
  } catch (e) {
    console.warn("[init] índice token_pool_fila_value_unique falhou:", (e as Error).message);
  }

  // Unique parcial para tokens de org (por valor + instância).
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS token_pool_org_value_instance_unique
        ON token_pool (value, owner_instance_id) WHERE type = 'org'
    `);
    console.log("[init] índice token_pool_org_value_instance_unique ok");
  } catch (e) {
    console.warn("[init] índice token_pool_org_value_instance_unique falhou:", (e as Error).message);
  }

  console.log("[init] migrações de isolamento concluídas");

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
