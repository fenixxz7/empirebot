-- Imperiuns Bot — Schema (Bloco A)
-- Apenas 1 instância (BOT1) por enquanto.

CREATE TABLE IF NOT EXISTS instances (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  running      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orgs (
  id           SERIAL PRIMARY KEY,
  guild_id     TEXT UNIQUE,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'Mobile',
  max_queues   INTEGER NOT NULL DEFAULT 5,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  priority     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS instance_configs (
  instance_id        INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
  category           TEXT NOT NULL DEFAULT 'Mobile',
  allowed_categories TEXT NOT NULL DEFAULT 'Mobile',
  delay_seconds      INTEGER NOT NULL DEFAULT 12,
  rotation_minutes   INTEGER NOT NULL DEFAULT 90,
  allowed_modes      TEXT NOT NULL DEFAULT '1x1
3x3',
  message_main       TEXT NOT NULL DEFAULT 'Oii Moçooo me manda uma mensagem no {adversary_mention}',
  message_per_org    TEXT NOT NULL DEFAULT '',
  image_url          TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instance_orgs (
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (instance_id, org_id)
);

CREATE TABLE IF NOT EXISTS tokens (
  id            SERIAL PRIMARY KEY,
  instance_id   INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  value         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'unknown',
  username      TEXT,
  last_used_at  TIMESTAMPTZ,
  UNIQUE (instance_id, position)
);

CREATE TABLE IF NOT EXISTS stats (
  instance_id   INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
  entradas      INTEGER NOT NULL DEFAULT 0,
  na_fila       INTEGER NOT NULL DEFAULT 0,
  partidas      INTEGER NOT NULL DEFAULT 0,
  dms           INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS logs (
  id            BIGSERIAL PRIMARY KEY,
  instance_id   INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level         TEXT NOT NULL DEFAULT 'INFO',
  source        TEXT,
  message       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_instance_ts ON logs (instance_id, ts DESC);

-- Bloco C — canais de fila descobertos por org
CREATE TABLE IF NOT EXISTS org_channels (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL,
  channel_name    TEXT,
  category        TEXT,
  mode            TEXT,
  message_id      TEXT NOT NULL DEFAULT '',
  embed_title     TEXT,
  application_id  TEXT,
  buttons         JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_scanned_at TIMESTAMPTZ,
  UNIQUE (org_id, channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_org_channels_org ON org_channels (org_id);

-- Bloco D — fila ativa em memória persistida pra estatística.
-- Cada canal pode ter múltiplas filas (mensagens) simultâneas, então a
-- chave única inclui message_id.
CREATE TABLE IF NOT EXISTS active_queues (
  id              SERIAL PRIMARY KEY,
  instance_id     INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL,
  message_id      TEXT NOT NULL DEFAULT '',
  mode            TEXT,
  category        TEXT,
  token_id        INTEGER,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instance_id, channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_active_queues_instance
  ON active_queues (instance_id);
