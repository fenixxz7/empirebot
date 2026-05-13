import { query } from "../db/pool.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WatchdogAlert {
  id: number;
  instance_id: number | null;
  alert_type: string;
  severity: "info" | "warn" | "critical";
  detail: string | null;
  resolved: boolean;
  created_at: string;
  resolved_at: string | null;
}

// ─── Watchdog State ───────────────────────────────────────────────────────────

let watchdogTimer: NodeJS.Timeout | null = null;

// Rastreia contagens de failover por instância para auto-pause
const recentFailoverCounts = new Map<number, number[]>(); // instanceId → timestamps dos failovers
const FAILOVER_PAUSE_THRESHOLD = 3; // >3 failovers em 30 min → auto-pause
const FAILOVER_WINDOW_MS = 30 * 60 * 1000;

// Rastreia loops de rotação por instância
const ROTATION_LOOP_THRESHOLD = 5; // >5 rotações em 1h → alerta
const ROTATION_LOOP_WINDOW_MS = 60 * 60 * 1000;

// ─── Alert Helpers ────────────────────────────────────────────────────────────

async function createAlert(
  instanceId: number | null,
  alertType: string,
  severity: "info" | "warn" | "critical",
  detail: string
): Promise<void> {
  try {
    // Evita duplicar alertas não resolvidos do mesmo tipo/instância
    const existing = await query<{ id: number }>(
      `SELECT id FROM watchdog_alerts
       WHERE alert_type = $1
         AND (instance_id = $2 OR ($2 IS NULL AND instance_id IS NULL))
         AND resolved = FALSE
         AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [alertType, instanceId]
    );
    if (existing.length > 0) return;

    await query(
      `INSERT INTO watchdog_alerts (instance_id, alert_type, severity, detail) VALUES ($1,$2,$3,$4)`,
      [instanceId, alertType, severity, detail]
    );

    await query(
      `INSERT INTO account_logs (account_id, instance_id, event_type, detail) VALUES (NULL,$1,$2,$3)`,
      [instanceId, "watchdog_alert", `[${severity.toUpperCase()}] ${alertType}: ${detail}`]
    );

    console.warn(`[watchdog] ALERTA inst=${instanceId ?? "global"} ${severity.toUpperCase()} ${alertType}: ${detail}`);
  } catch (err) {
    console.error("[watchdog] createAlert error:", err);
  }
}

async function resolveAlert(alertType: string, instanceId: number | null): Promise<void> {
  try {
    await query(
      `UPDATE watchdog_alerts SET resolved = TRUE, resolved_at = NOW()
       WHERE alert_type = $1
         AND (instance_id = $2 OR ($2 IS NULL AND instance_id IS NULL))
         AND resolved = FALSE`,
      [alertType, instanceId]
    );
  } catch {}
}

// ─── Check: Orphan Locks ──────────────────────────────────────────────────────

async function checkOrphanLocks(): Promise<void> {
  try {
    const orphans = await query<{ id: number; nickname: string; locked_by_instance: number | null }>(`
      SELECT id, nickname, locked_by_instance
      FROM accounts
      WHERE account_lock = TRUE
        AND lock_expires_at IS NOT NULL
        AND lock_expires_at < NOW()
    `);

    for (const acc of orphans) {
      await query(`
        UPDATE accounts SET
          account_lock = FALSE, locked_by_instance = NULL,
          locked_at = NULL, lock_expires_at = NULL
        WHERE id = $1
      `, [acc.id]);

      await query(
        `INSERT INTO account_logs (account_id, instance_id, event_type, detail) VALUES ($1,$2,'lock_released',$3)`,
        [acc.id, acc.locked_by_instance, "Lock órfão liberado pelo Watchdog (expirado)"]
      );

      await createAlert(
        acc.locked_by_instance,
        "orphan_lock_released",
        "warn",
        `Lock órfão liberado na conta "${acc.nickname}" (id=${acc.id})`
      );
    }

    if (orphans.length > 0) {
      console.log(`[watchdog] ${orphans.length} lock(s) órfão(s) liberado(s)`);
    }
  } catch (err) {
    console.error("[watchdog] checkOrphanLocks error:", err);
  }
}

// ─── Check: Rotation Loops ────────────────────────────────────────────────────

async function checkRotationLoops(): Promise<void> {
  try {
    const rows = await query<{ instance_id: number; rotations: number }>(`
      SELECT instance_id, COUNT(*) AS rotations
      FROM rotation_history
      WHERE rotated_at > NOW() - INTERVAL '1 hour'
      GROUP BY instance_id
      HAVING COUNT(*) > $1
    `, [ROTATION_LOOP_THRESHOLD]);

    for (const row of rows) {
      await createAlert(
        row.instance_id,
        "rotation_loop",
        "critical",
        `${row.rotations} rotações em 1 hora — possível loop de rotação`
      );
    }

    // Resolve alerta se voltou ao normal
    const allInstances = await query<{ instance_id: number; rotations: number }>(`
      SELECT instance_id, COUNT(*) AS rotations
      FROM rotation_history
      WHERE rotated_at > NOW() - INTERVAL '1 hour'
      GROUP BY instance_id
    `);

    const loopingIds = new Set(rows.map(r => r.instance_id));
    for (const row of allInstances) {
      if (!loopingIds.has(row.instance_id) && row.rotations <= ROTATION_LOOP_THRESHOLD) {
        await resolveAlert("rotation_loop", row.instance_id);
      }
    }
  } catch (err) {
    console.error("[watchdog] checkRotationLoops error:", err);
  }
}

// ─── Check: Excessive Failovers ──────────────────────────────────────────────

async function checkExcessiveFailovers(): Promise<void> {
  try {
    const rows = await query<{ instance_id: number; failovers: number }>(`
      SELECT instance_id, COUNT(*) AS failovers
      FROM rotation_history
      WHERE result = 'failover'
        AND rotated_at > NOW() - INTERVAL '30 minutes'
      GROUP BY instance_id
      HAVING COUNT(*) >= $1
    `, [FAILOVER_PAUSE_THRESHOLD]);

    for (const row of rows) {
      await createAlert(
        row.instance_id,
        "excessive_failovers",
        "critical",
        `${row.failovers} failovers em 30 min — auto-pausa de emergência ativada`
      );

      // Importa dinamicamente para evitar dependência circular
      try {
        const { setWatchdogPause } = await import("./auto-rotator.js");
        setWatchdogPause(true);
        await query(`
          UPDATE accounts_config SET rotation_paused = TRUE WHERE id = 1
        `);
        console.warn(`[watchdog] inst=${row.instance_id} auto-pausa ativada por excesso de failovers`);
      } catch {}
    }
  } catch (err) {
    console.error("[watchdog] checkExcessiveFailovers error:", err);
  }
}

// ─── Check: Account Oscillation ──────────────────────────────────────────────

async function checkAccountOscillation(): Promise<void> {
  try {
    // Conta que alternaram entre ACTIVE e ERROR/INVALID mais de 3 vezes em 1h
    const rows = await query<{ account_id: number; nickname: string; changes: number }>(`
      SELECT al.account_id, a.nickname, COUNT(*) AS changes
      FROM account_logs al
      INNER JOIN accounts a ON a.id = al.account_id
      WHERE al.event_type IN ('activated', 'failure', 'state_change')
        AND al.ts > NOW() - INTERVAL '1 hour'
      GROUP BY al.account_id, a.nickname
      HAVING COUNT(*) >= 6
    `);

    for (const row of rows) {
      await createAlert(
        null,
        "account_oscillation",
        "warn",
        `Conta "${row.nickname}" (id=${row.account_id}) oscilando — ${row.changes} mudanças de estado em 1h`
      );
    }
  } catch (err) {
    console.error("[watchdog] checkAccountOscillation error:", err);
  }
}

// ─── Check: Insufficient Pool ────────────────────────────────────────────────

async function checkInsufficientPool(): Promise<void> {
  try {
    const rows = await query<{ usable: number; total: number }>(`
      SELECT
        COUNT(*) FILTER (
          WHERE state NOT IN ('DEAD','BANNED','INVALID_TOKEN','NEEDS_VERIFICATION',
                              'LOGIN_CHALLENGE','MANUAL_ACTION_REQUIRED','ERROR')
            AND (cooldown_until IS NULL OR cooldown_until < NOW())
            AND (quarantine_until IS NULL OR quarantine_until < NOW())
        ) AS usable,
        COUNT(*) AS total
      FROM accounts
    `);

    const { usable, total } = rows[0] ?? { usable: 0, total: 0 };
    const usableNum = Number(usable);
    const totalNum = Number(total);

    if (totalNum > 0 && usableNum === 0) {
      await createAlert(null, "pool_empty", "critical", "Nenhuma conta utilizável disponível no pool");
    } else if (totalNum > 0 && usableNum / totalNum < 0.2) {
      await createAlert(
        null, "pool_critical",
        "critical",
        `Pool crítico: apenas ${usableNum}/${totalNum} contas utilizáveis (${Math.round(usableNum / totalNum * 100)}%)`
      );
    } else {
      await resolveAlert("pool_empty", null);
      await resolveAlert("pool_critical", null);
    }
  } catch (err) {
    console.error("[watchdog] checkInsufficientPool error:", err);
  }
}

// ─── Check: High Rollback Rate ────────────────────────────────────────────────

async function checkHighRollbackRate(): Promise<void> {
  try {
    const rows = await query<{ total: number; rollbacks: number }>(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE result = 'rollback') AS rollbacks
      FROM rotation_history
      WHERE rotated_at > NOW() - INTERVAL '1 hour'
    `);

    const total = Number(rows[0]?.total ?? 0);
    const rollbacks = Number(rows[0]?.rollbacks ?? 0);

    if (total >= 3 && rollbacks / total >= 0.5) {
      await createAlert(
        null, "high_rollback_rate",
        "critical",
        `Taxa de rollback alta: ${rollbacks}/${total} rotações com rollback na última hora`
      );
    } else {
      await resolveAlert("high_rollback_rate", null);
    }
  } catch (err) {
    console.error("[watchdog] checkHighRollbackRate error:", err);
  }
}

// ─── Clean Old Alerts ─────────────────────────────────────────────────────────

async function cleanOldAlerts(): Promise<void> {
  try {
    await query(`
      DELETE FROM watchdog_alerts
      WHERE resolved = TRUE AND resolved_at < NOW() - INTERVAL '48 hours'
    `);
  } catch {}
}

// ─── Main Watchdog Loop ───────────────────────────────────────────────────────

async function runWatchdog(): Promise<void> {
  await checkOrphanLocks();
  await checkRotationLoops();
  await checkExcessiveFailovers();
  await checkAccountOscillation();
  await checkInsufficientPool();
  await checkHighRollbackRate();
  await cleanOldAlerts();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startWatchdog(intervalMs = 60_000): void {
  if (watchdogTimer) return;
  // Executa imediatamente 10s após inicio para não sobrecarregar o boot
  setTimeout(() => {
    runWatchdog().catch(err => console.error("[watchdog] run error:", err));
  }, 10_000);
  watchdogTimer = setInterval(() => {
    runWatchdog().catch(err => console.error("[watchdog] run error:", err));
  }, intervalMs);
  console.log("[watchdog] watchdog iniciado");
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

export async function getWatchdogAlerts(limit = 50, onlyOpen = false): Promise<WatchdogAlert[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, instance_id, alert_type, severity, detail, resolved, created_at, resolved_at
     FROM watchdog_alerts
     WHERE ($1 = FALSE OR resolved = FALSE)
     ORDER BY created_at DESC
     LIMIT $2`,
    [onlyOpen, limit]
  );
  return rows;
}

export async function resolveWatchdogAlert(id: number): Promise<void> {
  await query(
    `UPDATE watchdog_alerts SET resolved = TRUE, resolved_at = NOW() WHERE id = $1`,
    [id]
  );
}
