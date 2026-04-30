import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool, query } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


export async function initDatabase(): Promise<void> {
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);

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
  }

  // Garante que ninguém ficou com fila "fantasma" entre boots
  await pool.query(`DELETE FROM active_queues`);

  const instances = await query<{ id: number }>(
    `INSERT INTO instances (name, running)
     VALUES ('BOT1', FALSE)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
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
