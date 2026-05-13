import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

type AccountState =
  | "ACTIVE" | "IDLE" | "STANDBY" | "COOLING" | "RESERVED" | "WAITING"
  | "REAUTH" | "INVALID_TOKEN" | "NEEDS_VERIFICATION" | "LOGIN_CHALLENGE"
  | "MANUAL_ACTION_REQUIRED" | "LIMITED" | "ERROR" | "DEAD" | "BANNED";

type RotationStrategy = "sequential" | "random" | "weighted_health" | "least_recently_used";

interface Account {
  id: number;
  nickname: string;
  email: string | null;
  has_token: boolean;
  token_value_preview: string | null;
  token_pool_id: number | null;
  instance_id: number | null;
  instance_name: string | null;
  token_status: string | null;
  token_username: string | null;
  state: AccountState;
  health_score: number;
  tier: string;
  consecutive_failures: number;
  failure_count: number;
  rotation_count: number;
  auto_rotation: boolean;
  auto_refresh: boolean;
  auto_relogin: boolean;
  min_use_ms: number | null;
  max_use_ms: number | null;
  auto_time_mode: boolean;
  activated_at: string | null;
  last_active_at: string | null;
  last_rotation_at: string | null;
  cooldown_until: string | null;
  quarantine_until: string | null;
  account_lock: boolean;
  locked_by_instance: number | null;
  locked_by_instance_name: string | null;
  lock_expires_at: string | null;
  notes: string | null;
  created_at: string;
}

interface AccountLog {
  id: number;
  account_id: number | null;
  account_name: string | null;
  instance_id: number | null;
  instance_name: string | null;
  event_type: string;
  detail: string | null;
  ts: string;
}

interface AccountsConfig {
  max_active: number;
  min_health_score: number;
  max_continuous_ms: number;
  min_use_ms: number | null;
  max_use_ms: number | null;
  auto_time_mode: boolean;
  cooldown_after_use_ms: number;
  cooldown_after_fail_ms: number;
  quarantine_ms: number;
  health_check_interval_ms: number;
  session_validation_interval_ms: number;
  token_validation_interval_ms: number;
  reauth_preventive_ms: number;
  auto_rotation: boolean;
  auto_refresh: boolean;
  auto_relogin: boolean;
  rotation_strategy: RotationStrategy;
}

interface TokenPoolItem {
  id: number;
  label: string | null;
  value_preview: string;
  status: string;
  username: string | null;
}

interface Instance {
  id: number;
  name: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_META: Record<AccountState, { label: string; color: string; bg: string; ring: string; dot: string }> = {
  ACTIVE:                 { label: "ATIVO",          color: "text-emerald-300", bg: "bg-emerald-400/10", ring: "ring-emerald-400/30", dot: "bg-emerald-400" },
  IDLE:                   { label: "IDLE",            color: "text-sky-300",     bg: "bg-sky-400/10",     ring: "ring-sky-400/30",     dot: "bg-sky-400" },
  STANDBY:                { label: "STANDBY",         color: "text-slate-300",   bg: "bg-white/5",        ring: "ring-white/10",       dot: "bg-slate-400" },
  COOLING:                { label: "COOLING",         color: "text-cyan-300",    bg: "bg-cyan-400/10",    ring: "ring-cyan-400/30",    dot: "bg-cyan-400" },
  RESERVED:               { label: "RESERVADO",       color: "text-violet-300",  bg: "bg-violet-400/10",  ring: "ring-violet-400/30",  dot: "bg-violet-400" },
  WAITING:                { label: "AGUARDANDO",      color: "text-amber-300",   bg: "bg-amber-400/10",   ring: "ring-amber-400/30",   dot: "bg-amber-400" },
  REAUTH:                 { label: "REAUTH",          color: "text-orange-300",  bg: "bg-orange-400/10",  ring: "ring-orange-400/30",  dot: "bg-orange-400" },
  INVALID_TOKEN:          { label: "TOKEN INVÁLIDO",  color: "text-rose-300",    bg: "bg-rose-400/10",    ring: "ring-rose-400/30",    dot: "bg-rose-400" },
  NEEDS_VERIFICATION:     { label: "VERIFICAÇÃO",     color: "text-yellow-300",  bg: "bg-yellow-400/10",  ring: "ring-yellow-400/30",  dot: "bg-yellow-400" },
  LOGIN_CHALLENGE:        { label: "CHALLENGE",       color: "text-orange-400",  bg: "bg-orange-400/10",  ring: "ring-orange-400/40",  dot: "bg-orange-400" },
  MANUAL_ACTION_REQUIRED: { label: "AÇÃO MANUAL",     color: "text-red-300",     bg: "bg-red-400/10",     ring: "ring-red-400/30",     dot: "bg-red-400" },
  LIMITED:                { label: "LIMITADO",        color: "text-amber-400",   bg: "bg-amber-400/10",   ring: "ring-amber-400/40",   dot: "bg-amber-400" },
  ERROR:                  { label: "ERRO",            color: "text-rose-400",    bg: "bg-rose-400/10",    ring: "ring-rose-400/40",    dot: "bg-rose-400" },
  DEAD:                   { label: "MORTO",           color: "text-red-500",     bg: "bg-red-500/10",     ring: "ring-red-500/30",     dot: "bg-red-500" },
  BANNED:                 { label: "BANIDO",          color: "text-red-600",     bg: "bg-red-600/10",     ring: "ring-red-600/30",     dot: "bg-red-600" },
};

const TIER_META: Record<string, { color: string; bg: string; label: string }> = {
  S: { color: "text-yellow-300",  bg: "bg-yellow-400/15", label: "S" },
  A: { color: "text-emerald-300", bg: "bg-emerald-400/15", label: "A" },
  B: { color: "text-sky-300",     bg: "bg-sky-400/15",    label: "B" },
  C: { color: "text-amber-300",   bg: "bg-amber-400/15",  label: "C" },
  D: { color: "text-rose-300",    bg: "bg-rose-400/15",   label: "D" },
};

const ALL_STATES: AccountState[] = [
  "ACTIVE","IDLE","STANDBY","COOLING","RESERVED","WAITING","REAUTH",
  "INVALID_TOKEN","NEEDS_VERIFICATION","LOGIN_CHALLENGE","MANUAL_ACTION_REQUIRED",
  "LIMITED","ERROR","DEAD","BANNED",
];

const TOKEN_STATUS_META: Record<string, { label: string; color: string }> = {
  connected:    { label: "Conectado",    color: "text-emerald-400" },
  rate_limited: { label: "Rate Limit",  color: "text-amber-400" },
  invalid:      { label: "Inválido",    color: "text-rose-400" },
  disconnected: { label: "Desconectado",color: "text-slate-400" },
  unknown:      { label: "Desconhecido",color: "text-slate-500" },
};

const LOG_EVENT_COLORS: Record<string, string> = {
  created:                "text-emerald-400",
  activated:              "text-emerald-300",
  deactivated:            "text-slate-400",
  state_change:           "text-sky-300",
  rotation:               "text-violet-300",
  failure:                "text-rose-400",
  reset:                  "text-amber-300",
  auto_rotation_started:  "text-violet-400",
  auto_rotation_aborted:  "text-rose-400",
  account_selected:       "text-sky-300",
  validation_approved:    "text-emerald-400",
  validation_failed:      "text-rose-400",
  heartbeat_validated:    "text-emerald-300",
  cooldown_applied:       "text-cyan-300",
  lock_created:           "text-slate-400",
  lock_released:          "text-slate-400",
  token_applied:          "text-sky-400",
  rollback_executed:      "text-amber-400",
  failover_executed:      "text-orange-400",
  anti_pingpong_applied:  "text-violet-300",
  default:                "text-slate-300",
};

// ─── Rotation Types ───────────────────────────────────────────────────────────

interface RotationStatusEntry {
  instance_id: number;
  instance_name: string;
  in_progress: boolean;
  last_reason: string | null;
  last_reason_label: string | null;
  last_rotated_at: string | null;
  active_account_id: number | null;
  active_account_nickname: string | null;
  next_eligible_at: string | null;
  cooldown_remaining_ms: number | null;
  failover_active: boolean;
  auto_rotation_enabled: boolean;
  active_account_auto_rotation: boolean;
}

interface RotationHistoryEntry {
  id: number;
  instance_id: number;
  instance_name: string | null;
  old_account_name: string | null;
  new_account_name: string | null;
  reason: string;
  result: string;
  detail: string | null;
  rotated_at: string;
}

// ─── Pool por Instância types ─────────────────────────────────────────────────

interface PoolAccountEntry {
  id: number;
  nickname: string;
  email: string | null;
  state: string;
  health_score: number;
  tier: string;
  is_exclusive: boolean;
  is_global: boolean;
  is_available: boolean;
  unavailable_reasons: string[];
  is_active: boolean;
  in_cooldown: boolean;
  in_quarantine: boolean;
  locked_by_other: boolean;
  locked_by_instance_name: string | null;
}

interface InstancePoolSummary {
  instance_id: number;
  instance_name: string;
  exclusive_accounts_count: number;
  global_available_count: number;
  active_count: number;
  cooldown_count: number;
  quarantine_count: number;
  locked_by_other_count: number;
  usable_count: number;
  average_health: number;
  best_available_account: { id: number; nickname: string; health_score: number; tier: string } | null;
  unavailable_reasons_summary: Record<string, number>;
  accounts: PoolAccountEntry[];
}

const ROTATION_STRATEGIES: { value: RotationStrategy; label: string }[] = [
  { value: "sequential",          label: "Sequential" },
  { value: "random",              label: "Random" },
  { value: "weighted_health",     label: "Weighted Health (recomendado)" },
  { value: "least_recently_used", label: "Least Recently Used" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRelative(ts: string | null): string {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h atrás`;
  return `${Math.floor(h / 24)}d atrás`;
}

function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${h}h ${rem}min` : `${h}h`;
}

function fmtTs(ts: string): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function healthColor(score: number): string {
  if (score >= 75) return "bg-emerald-500";
  if (score >= 50) return "bg-amber-500";
  if (score >= 25) return "bg-orange-500";
  return "bg-rose-500";
}

function healthTextColor(score: number): string {
  if (score >= 75) return "text-emerald-400";
  if (score >= 50) return "text-amber-400";
  if (score >= 25) return "text-orange-400";
  return "text-rose-400";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StateBadge({ state }: { state: AccountState }) {
  const m = STATE_META[state] ?? STATE_META.STANDBY;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${m.color} ${m.bg} ring-1 ${m.ring}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot} ${state === "ACTIVE" ? "animate-pulse" : ""}`} />
      {m.label}
    </span>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const m = TIER_META[tier] ?? TIER_META.D;
  return (
    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-black ${m.color} ${m.bg}`}>
      {m.label}
    </span>
  );
}

function HealthBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${healthColor(score)}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className={`text-xs font-bold tabular-nums w-8 text-right ${healthTextColor(score)}`}>{score}%</span>
    </div>
  );
}

// ─── Account Card ─────────────────────────────────────────────────────────────

function AccountCard({
  account, onAction, onEdit,
}: {
  account: Account;
  onAction: (id: number, action: string) => void;
  onEdit: (account: Account) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isActive = account.state === "ACTIVE";
  const isStandby = ["STANDBY", "IDLE", "COOLING"].includes(account.state);
  const isCooling = account.state === "COOLING";
  const now = new Date();
  const inCooldown = account.cooldown_until && new Date(account.cooldown_until) > now;
  const inQuarantine = account.quarantine_until && new Date(account.quarantine_until) > now;

  return (
    <div className={`card p-4 flex flex-col gap-3 transition-all duration-200 ${isActive ? "ring-1 ring-emerald-500/30" : ""} ${inQuarantine ? "ring-1 ring-red-500/30" : ""}`}>
      {/* Header row */}
      <div className="flex items-start gap-3">
        <TierBadge tier={account.tier} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{account.nickname}</span>
            <StateBadge state={account.state} />
          </div>
          {account.email && (
            <p className="text-[11px] text-slate-500 mt-0.5 truncate">{account.email}</p>
          )}
          {account.instance_name && (
            <p className="text-[11px] text-cyan-500 mt-0.5">Instância: {account.instance_name}</p>
          )}
        </div>
        <button
          onClick={() => onEdit(account)}
          className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors p-1 rounded"
          title="Editar"
        >
          ✏️
        </button>
      </div>

      {/* Health bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Health Score</span>
        </div>
        <HealthBar score={account.health_score} />
      </div>

      {/* Quick stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Token</p>
          <p className={`text-[11px] font-semibold mt-0.5 ${TOKEN_STATUS_META[account.token_status ?? "unknown"]?.color ?? "text-slate-400"}`}>
            {TOKEN_STATUS_META[account.token_status ?? "unknown"]?.label ?? "—"}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Rotações</p>
          <p className="text-[11px] font-semibold text-slate-300 mt-0.5">{account.rotation_count}</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Falhas</p>
          <p className={`text-[11px] font-semibold mt-0.5 ${account.consecutive_failures > 0 ? "text-rose-400" : "text-slate-300"}`}>
            {account.consecutive_failures > 0 ? `${account.consecutive_failures} cons.` : account.failure_count}
          </p>
        </div>
      </div>

      {/* Cooldown/Quarantine warning */}
      {inQuarantine && (
        <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-[11px] text-red-300">
          ⛔ Quarentena até {new Date(account.quarantine_until!).toLocaleTimeString("pt-BR")}
        </div>
      )}
      {!inQuarantine && inCooldown && (
        <div className="rounded-lg bg-cyan-500/10 ring-1 ring-cyan-500/30 px-3 py-2 text-[11px] text-cyan-300">
          ❄️ Cooldown até {new Date(account.cooldown_until!).toLocaleTimeString("pt-BR")}
        </div>
      )}
      {account.account_lock && account.lock_expires_at && new Date(account.lock_expires_at) > now && (
        <div className="rounded-lg bg-violet-500/10 ring-1 ring-violet-500/30 px-3 py-2 text-[11px] text-violet-300">
          🔒 Em uso{account.locked_by_instance_name ? ` por ${account.locked_by_instance_name}` : ""} · expira {new Date(account.lock_expires_at).toLocaleTimeString("pt-BR")}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="space-y-1.5 border-t border-white/5 pt-3 text-[11px] text-slate-400">
          <div className="flex justify-between"><span>Última atividade</span><span className="text-slate-300">{fmtRelative(account.last_active_at)}</span></div>
          <div className="flex justify-between"><span>Última rotação</span><span className="text-slate-300">{fmtRelative(account.last_rotation_at)}</span></div>
          <div className="flex justify-between"><span>Ativada em</span><span className="text-slate-300">{fmtRelative(account.activated_at)}</span></div>
          <div className="flex justify-between"><span>Falhas totais</span><span className="text-slate-300">{account.failure_count}</span></div>
          <div className="flex justify-between"><span>Auto-rotação</span><span className={account.auto_rotation ? "text-emerald-400" : "text-slate-500"}>{account.auto_rotation ? "Sim" : "Não"}</span></div>
          <div className="flex justify-between"><span>Auto-refresh</span><span className={account.auto_refresh ? "text-emerald-400" : "text-slate-500"}>{account.auto_refresh ? "Sim" : "Não"}</span></div>
          <div className="flex justify-between"><span>Auto-relogin</span><span className={account.auto_relogin ? "text-amber-400" : "text-slate-500"}>{account.auto_relogin ? "Sim" : "Não"}</span></div>
          {!account.auto_time_mode && (
            <>
              <div className="flex justify-between"><span>Tempo mín.</span><span className="text-slate-300">{fmtDuration(account.min_use_ms)}</span></div>
              <div className="flex justify-between"><span>Tempo máx.</span><span className="text-slate-300">{fmtDuration(account.max_use_ms)}</span></div>
            </>
          )}
          {account.auto_time_mode && (
            <div className="flex justify-between"><span>Tempo de uso</span><span className="text-violet-400">Automático</span></div>
          )}
          <div className="flex justify-between"><span>Token próprio</span><span className={account.has_token ? "text-emerald-400" : "text-slate-500"}>{account.has_token ? `Sim (${account.token_value_preview})` : "Não"}</span></div>
          {account.token_username && (
            <div className="flex justify-between"><span>Token user</span><span className="text-slate-300">@{account.token_username}</span></div>
          )}
          {account.account_lock && account.lock_expires_at && (
            <div className="flex justify-between"><span>Lock</span><span className="text-violet-300">🔒 {account.locked_by_instance_name ?? "ativo"} até {new Date(account.lock_expires_at).toLocaleTimeString("pt-BR")}</span></div>
          )}
          {account.notes && (
            <div className="pt-1 border-t border-white/5">
              <p className="text-slate-500">Notas: <span className="text-slate-300">{account.notes}</span></p>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-1.5 flex-wrap pt-1 border-t border-white/5">
        <button
          onClick={() => setExpanded(e => !e)}
          className="btn-secondary text-[10px]"
        >
          {expanded ? "▲ Menos" : "▼ Mais"}
        </button>

        {!isActive && !inQuarantine && (
          <button
            onClick={() => onAction(account.id, "activate")}
            className="btn text-[10px] px-2.5 py-1.5 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 ring-1 ring-emerald-400/30"
          >
            ▶ Ativar
          </button>
        )}
        {isActive && (
          <button
            onClick={() => onAction(account.id, "deactivate")}
            className="btn text-[10px] px-2.5 py-1.5 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 ring-1 ring-amber-400/30"
          >
            ⏸ Pausar
          </button>
        )}
        {isActive && (
          <button
            onClick={() => onAction(account.id, "rotate")}
            className="btn text-[10px] px-2.5 py-1.5 bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 ring-1 ring-violet-400/30"
          >
            ↻ Rotar
          </button>
        )}
        {account.account_lock && (
          <button
            onClick={() => onAction(account.id, "unlock")}
            className="btn text-[10px] px-2.5 py-1.5 bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 ring-1 ring-violet-400/30"
          >
            🔓 Unlock
          </button>
        )}
        <button
          onClick={() => onAction(account.id, "reset")}
          className="btn-secondary text-[10px]"
        >
          ⟳ Reset
        </button>
      </div>
    </div>
  );
}

// ─── Pool por Instância Panel ─────────────────────────────────────────────────

type PoolFilter = {
  onlyAvailable: boolean;
  showLocked: boolean;
  showGlobal: boolean;
  showExclusive: boolean;
  showCooldown: boolean;
  showQuarantine: boolean;
  showInvalid: boolean;
};

const POOL_FILTER_DEFAULT: PoolFilter = {
  onlyAvailable: false,
  showLocked: true,
  showGlobal: true,
  showExclusive: true,
  showCooldown: true,
  showQuarantine: true,
  showInvalid: true,
};

const UNAVAILABLE_STATES_SET = new Set([
  "DEAD","BANNED","INVALID_TOKEN","NEEDS_VERIFICATION","LOGIN_CHALLENGE","MANUAL_ACTION_REQUIRED",
]);

function poolFilterAccount(a: PoolAccountEntry, f: PoolFilter): boolean {
  if (f.onlyAvailable && !a.is_available) return false;
  if (!f.showLocked && a.locked_by_other) return false;
  if (!f.showGlobal && a.is_global) return false;
  if (!f.showExclusive && a.is_exclusive) return false;
  if (!f.showCooldown && a.in_cooldown) return false;
  if (!f.showQuarantine && a.in_quarantine) return false;
  if (!f.showInvalid && UNAVAILABLE_STATES_SET.has(a.state)) return false;
  return true;
}

function PoolAccountRow({ a, onGoTo }: { a: PoolAccountEntry; onGoTo?: () => void }) {
  const stateMeta = STATE_META[a.state as AccountState] ?? { label: a.state, color: "text-slate-400", bg: "bg-white/5", ring: "ring-white/10", dot: "bg-slate-400" };
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[11px] transition-colors ${a.is_available ? "bg-emerald-500/5 ring-1 ring-emerald-500/10" : "bg-white/3 ring-1 ring-white/5"}`}>
      <TierBadge tier={a.tier} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-white truncate">{a.nickname}</span>
          {a.is_exclusive && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-400/20 font-semibold">EXCLUSIVA</span>
          )}
          {a.is_global && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400 ring-1 ring-slate-400/20 font-semibold">GLOBAL</span>
          )}
          <span className={`text-[9px] px-1.5 py-0.5 rounded ${stateMeta.bg} ${stateMeta.color} ring-1 ${stateMeta.ring} font-semibold`}>{stateMeta.label}</span>
        </div>
        {a.email && <p className="text-slate-600 truncate mt-0.5">{a.email}</p>}
        {!a.is_available && a.unavailable_reasons.length > 0 && (
          <p className="text-rose-400/80 mt-0.5 truncate">⚠ {a.unavailable_reasons.join(" · ")}</p>
        )}
      </div>
      <div className="w-20 shrink-0">
        <HealthBar score={a.health_score} />
      </div>
      {onGoTo && (
        <button onClick={onGoTo} className="shrink-0 text-slate-600 hover:text-slate-300 text-[10px] transition-colors">
          ↗
        </button>
      )}
    </div>
  );
}

function InstancePoolCard({
  summary,
  filter,
  onGoToAccount,
}: {
  summary: InstancePoolSummary;
  filter: PoolFilter;
  onGoToAccount: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const available = summary.accounts.filter(a => a.is_available && poolFilterAccount(a, filter));
  const unavailable = summary.accounts.filter(a => !a.is_available && poolFilterAccount(a, filter));

  const usabilityPct = summary.accounts.length > 0
    ? Math.round((summary.usable_count / summary.accounts.length) * 100)
    : 0;

  const healthColor = summary.average_health >= 75 ? "text-emerald-400"
    : summary.average_health >= 50 ? "text-amber-400"
    : "text-rose-400";

  const usableColor = summary.usable_count === 0 ? "text-rose-400"
    : summary.usable_count <= 1 ? "text-amber-400"
    : "text-emerald-400";

  return (
    <div className="card p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-base font-extrabold text-white tracking-tight">{summary.instance_name}</p>
          <p className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">
            {summary.accounts.length} conta{summary.accounts.length !== 1 ? "s" : ""} no pool
          </p>
        </div>
        <div className={`text-2xl font-extrabold tabular-nums ${usableColor}`}>
          {summary.usable_count}
          <span className="text-xs text-slate-500 font-normal ml-1">usáveis</span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Exclusivas",   value: summary.exclusive_accounts_count, color: "text-cyan-400" },
          { label: "Globais disp.", value: summary.global_available_count,  color: "text-slate-300" },
          { label: "Ativas agora", value: summary.active_count,             color: "text-emerald-400" },
          { label: "Cooldown",     value: summary.cooldown_count,           color: summary.cooldown_count > 0 ? "text-cyan-300" : "text-slate-500" },
          { label: "Quarentena",   value: summary.quarantine_count,         color: summary.quarantine_count > 0 ? "text-red-400" : "text-slate-500" },
          { label: "Bloq. outra",  value: summary.locked_by_other_count,    color: summary.locked_by_other_count > 0 ? "text-violet-400" : "text-slate-500" },
        ].map(({ label, value, color }) => (
          <div key={label} className="text-center bg-white/3 rounded-lg py-2">
            <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
            <p className={`text-lg font-bold tabular-nums mt-0.5 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Health + usability bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500">Health médio do pool</span>
          <span className={`font-bold ${healthColor}`}>{summary.average_health}%</span>
        </div>
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${summary.average_health >= 75 ? "bg-emerald-500" : summary.average_health >= 50 ? "bg-amber-500" : "bg-rose-500"}`}
            style={{ width: `${summary.average_health}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500">Utilização do pool</span>
          <span className="text-slate-400">{usabilityPct}% utilizável</span>
        </div>
      </div>

      {/* Best available */}
      {summary.best_available_account && (
        <div
          className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 cursor-pointer hover:bg-emerald-500/10 transition-colors"
          onClick={() => onGoToAccount(summary.best_available_account!.id)}
        >
          <TierBadge tier={summary.best_available_account.tier} />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Melhor disponível</p>
            <p className="text-xs font-semibold text-white truncate">{summary.best_available_account.nickname}</p>
          </div>
          <span className="text-emerald-400 font-bold text-sm">{summary.best_available_account.health_score}%</span>
        </div>
      )}

      {summary.usable_count === 0 && (
        <div className="rounded-xl border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-300 text-center">
          ⚠ Nenhuma conta utilizável nesta instância
        </div>
      )}

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-[10px] text-slate-500 hover:text-slate-300 transition-colors text-center py-1 border-t border-white/5"
      >
        {expanded ? "▲ Recolher lista" : `▼ Ver todas as contas (${summary.accounts.length})`}
      </button>

      {/* Expanded account list */}
      {expanded && (
        <div className="space-y-3 border-t border-white/5 pt-3">
          {available.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-emerald-400/70 font-semibold">
                ✓ Disponíveis ({available.length})
              </p>
              {available.map(a => (
                <PoolAccountRow key={a.id} a={a} onGoTo={() => onGoToAccount(a.id)} />
              ))}
            </div>
          )}
          {unavailable.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-rose-400/70 font-semibold">
                ✗ Indisponíveis ({unavailable.length})
              </p>
              {unavailable.map(a => (
                <PoolAccountRow key={a.id} a={a} onGoTo={() => onGoToAccount(a.id)} />
              ))}
            </div>
          )}
          {available.length === 0 && unavailable.length === 0 && (
            <p className="text-center text-slate-500 text-xs py-4">Nenhuma conta visível com os filtros aplicados.</p>
          )}
        </div>
      )}
    </div>
  );
}

function PoolPanel({
  pool,
  loading,
  onRefresh,
  onGoToAccount,
}: {
  pool: InstancePoolSummary[];
  loading: boolean;
  onRefresh: () => void;
  onGoToAccount: (id: number) => void;
}) {
  const [filter, setFilter] = useState<PoolFilter>(POOL_FILTER_DEFAULT);

  function toggleFilter(key: keyof PoolFilter) {
    setFilter(f => ({ ...f, [key]: !f[key] }));
  }

  const toggleButtons: { key: keyof PoolFilter; label: string; activeColor: string }[] = [
    { key: "onlyAvailable", label: "Só disponíveis",  activeColor: "bg-emerald-500/20 text-emerald-300 ring-emerald-400/30" },
    { key: "showLocked",    label: "Bloqueadas",       activeColor: "bg-violet-500/20  text-violet-300  ring-violet-400/30" },
    { key: "showGlobal",    label: "Globais",          activeColor: "bg-slate-500/20   text-slate-300   ring-slate-400/30" },
    { key: "showExclusive", label: "Exclusivas",       activeColor: "bg-cyan-500/20    text-cyan-300    ring-cyan-400/30" },
    { key: "showCooldown",  label: "Cooldown",         activeColor: "bg-cyan-500/20    text-cyan-300    ring-cyan-400/30" },
    { key: "showQuarantine",label: "Quarentena",       activeColor: "bg-red-500/20     text-red-300     ring-red-400/30" },
    { key: "showInvalid",   label: "Inválidas",        activeColor: "bg-rose-500/20    text-rose-300    ring-rose-400/30" },
  ];

  if (loading) {
    return (
      <div className="card p-12 text-center text-slate-500 text-sm">Calculando pools...</div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1">Filtros:</span>
        {toggleButtons.map(({ key, label, activeColor }) => {
          const isActive = filter[key];
          return (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold ring-1 transition-colors ${
                isActive
                  ? activeColor
                  : "bg-white/5 text-slate-500 ring-white/10 hover:bg-white/10 hover:text-slate-400"
              }`}
            >
              {label}
            </button>
          );
        })}
        <button
          onClick={onRefresh}
          className="ml-auto btn-secondary text-[11px] py-1 px-2.5"
        >
          ↻ Atualizar
        </button>
      </div>

      {/* Global summary row */}
      {pool.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {
              label: "Total utilizáveis",
              value: pool.reduce((s, p) => s + p.usable_count, 0),
              color: "text-emerald-400",
            },
            {
              label: "Em cooldown",
              value: pool.reduce((s, p) => s + p.cooldown_count, 0),
              color: "text-cyan-300",
            },
            {
              label: "Em quarentena",
              value: pool.reduce((s, p) => s + p.quarantine_count, 0),
              color: "text-red-400",
            },
            {
              label: "Bloqueadas",
              value: pool.reduce((s, p) => s + p.locked_by_other_count, 0),
              color: "text-violet-400",
            },
          ].map(({ label, value, color }) => (
            <div key={label} className="card p-3 flex flex-col gap-0.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
              <p className={`text-2xl font-extrabold tabular-nums ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Per instance cards */}
      {pool.length === 0 ? (
        <div className="card p-12 text-center text-slate-500 text-sm">
          Nenhuma instância cadastrada. Configure instâncias no painel principal.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {pool.map(summary => (
            <InstancePoolCard
              key={summary.instance_id}
              summary={summary}
              filter={filter}
              onGoToAccount={onGoToAccount}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Account Form Modal ───────────────────────────────────────────────────────

function AccountForm({
  initial,
  tokens,
  instances,
  onSave,
  onCancel,
}: {
  initial: Partial<Account> | null;
  tokens: TokenPoolItem[];
  instances: Instance[];
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    nickname: initial?.nickname ?? "",
    email: initial?.email ?? "",
    password: "",
    token_value: "",
    token_pool_id: initial?.token_pool_id ?? "",
    instance_id: initial?.instance_id ?? "",
    auto_rotation: initial?.auto_rotation ?? true,
    auto_refresh: initial?.auto_refresh ?? true,
    auto_relogin: initial?.auto_relogin ?? false,
    auto_time_mode: initial?.auto_time_mode ?? true,
    min_use_ms: initial?.min_use_ms ? String(initial.min_use_ms / 60000) : "",
    max_use_ms: initial?.max_use_ms ? String(initial.max_use_ms / 60000) : "",
    notes: initial?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showTokenField, setShowTokenField] = useState(false);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    if (!form.nickname.trim()) { setError("Nome é obrigatório."); return; }
    setSaving(true);
    setError("");
    try {
      await onSave({
        nickname: form.nickname,
        email: form.email || null,
        password: form.password || null,
        token_value: form.token_value || null,
        token_pool_id: form.token_pool_id ? Number(form.token_pool_id) : null,
        instance_id: form.instance_id ? Number(form.instance_id) : null,
        auto_rotation: form.auto_rotation,
        auto_refresh: form.auto_refresh,
        auto_relogin: form.auto_relogin,
        auto_time_mode: form.auto_time_mode,
        min_use_ms: form.min_use_ms ? Number(form.min_use_ms) * 60000 : null,
        max_use_ms: form.max_use_ms ? Number(form.max_use_ms) * 60000 : null,
        notes: form.notes || null,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Erro ao salvar.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="card p-6 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-bold text-white">{initial?.id ? "Editar Conta" : "Nova Conta"}</h2>

        <div className="space-y-3">
          <div>
            <label className="label block mb-1">Nome / Nickname *</label>
            <input className="input" value={form.nickname} onChange={e => set("nickname", e.target.value)} placeholder="ex: Conta Principal" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">E-mail</label>
              <input className="input" type="email" value={form.email} onChange={e => set("email", e.target.value)} placeholder="exemplo@email.com" />
            </div>
            <div>
              <label className="label block mb-1">Senha <span className="text-slate-600">(opcional, fallback)</span></label>
              <input className="input" type="password" value={form.password} onChange={e => set("password", e.target.value)} placeholder="••••••••" />
            </div>
          </div>

          {/* Token proprio */}
          <div className="rounded-xl border border-white/8 bg-white/2 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-300">Token Discord</p>
                {initial?.id && initial.has_token && !showTokenField && (
                  <p className="text-[11px] text-emerald-400 mt-0.5">
                    ✓ Token salvo: <span className="font-mono">{initial.token_value_preview}</span>
                  </p>
                )}
                {initial?.id && !initial.has_token && !showTokenField && (
                  <p className="text-[11px] text-slate-500 mt-0.5">Nenhum token salvo</p>
                )}
                {!initial?.id && (
                  <p className="text-[11px] text-slate-500 mt-0.5">Cole o token do Discord (recomendado)</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowTokenField(v => !v)}
                className="text-[11px] text-accent hover:text-accent/80 transition-colors"
              >
                {showTokenField ? "▲ Fechar" : initial?.id ? "✏️ Alterar" : "➕ Adicionar"}
              </button>
            </div>
            {(showTokenField || !initial?.id) && (
              <input
                className="input font-mono text-xs"
                type="password"
                value={form.token_value}
                onChange={e => set("token_value", e.target.value)}
                placeholder={initial?.id ? "Novo token (vazio = manter atual)" : "Cole o token aqui..."}
                autoComplete="off"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">Instância vinculada</label>
              <select className="input" value={form.instance_id} onChange={e => set("instance_id", e.target.value)}>
                <option value="">— Nenhuma (global) —</option>
                {instances.map(i => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label block mb-1">Token do Pool <span className="text-slate-600">(legado)</span></label>
              <select className="input" value={form.token_pool_id} onChange={e => set("token_pool_id", e.target.value)}>
                <option value="">— Nenhum —</option>
                {tokens.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.label ? `${t.label} · ` : ""}{t.value_preview} ({t.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Auto flags */}
          <div className="grid grid-cols-3 gap-2">
            {([
              ["auto_rotation", "Auto-rotação"],
              ["auto_refresh",  "Auto-refresh"],
              ["auto_relogin",  "Auto-relogin"],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={e => set(key, e.target.checked)}
                  className="w-4 h-4 rounded border-white/20 bg-navy-950 text-accent focus:ring-accent/30"
                />
                <span className="text-xs text-slate-300">{label}</span>
              </label>
            ))}
          </div>

          {/* Time mode */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.auto_time_mode}
                onChange={e => set("auto_time_mode", e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-navy-950 text-accent focus:ring-accent/30"
              />
              <span className="text-xs text-slate-300">Modo automático de tempo de uso</span>
            </label>
          </div>

          {!form.auto_time_mode && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label block mb-1">Tempo mínimo (min)</label>
                <input className="input" type="number" min={0} value={form.min_use_ms} onChange={e => set("min_use_ms", e.target.value)} placeholder="ex: 30" />
              </div>
              <div>
                <label className="label block mb-1">Tempo máximo (min)</label>
                <input className="input" type="number" min={0} value={form.max_use_ms} onChange={e => set("max_use_ms", e.target.value)} placeholder="ex: 120" />
              </div>
            </div>
          )}

          <div>
            <label className="label block mb-1">Notas</label>
            <textarea className="textarea" rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Observações..." />
          </div>
        </div>

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" onClick={onCancel}>Cancelar</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── State Change Modal ───────────────────────────────────────────────────────

function StateModal({
  accountId,
  current,
  onSave,
  onCancel,
}: {
  accountId: number;
  current: AccountState;
  onSave: (state: AccountState, reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [state, setState] = useState<AccountState>(current);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await onSave(state, reason);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="card p-6 w-full max-w-sm space-y-4">
        <h2 className="text-base font-bold text-white">Alterar Estado — Conta #{accountId}</h2>
        <div>
          <label className="label block mb-1">Novo estado</label>
          <select className="input" value={state} onChange={e => setState(e.target.value as AccountState)}>
            {ALL_STATES.map(s => (
              <option key={s} value={s}>{STATE_META[s].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label block mb-1">Motivo (opcional)</label>
          <input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="ex: Rate limit detectado" />
        </div>
        <div className="flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onCancel}>Cancelar</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>Salvar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Config Panel ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AccountsConfig = {
  max_active: 10,
  min_health_score: 40,
  max_continuous_ms: 7200000,
  min_use_ms: null,
  max_use_ms: null,
  auto_time_mode: true,
  cooldown_after_use_ms: 2700000,
  cooldown_after_fail_ms: 1800000,
  quarantine_ms: 3600000,
  health_check_interval_ms: 30000,
  session_validation_interval_ms: 120000,
  token_validation_interval_ms: 300000,
  reauth_preventive_ms: 21600000,
  auto_rotation: true,
  auto_refresh: true,
  auto_relogin: false,
  rotation_strategy: "weighted_health",
};

function ConfigPanel({ config, onSave }: { config: AccountsConfig; onSave: (c: AccountsConfig) => Promise<void> }) {
  const [form, setForm] = useState<AccountsConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (k: keyof AccountsConfig, v: unknown) =>
    setForm(f => ({ ...f, [k]: v }));

  const msToMin = (ms: number | null) => ms == null ? "" : String(ms / 60000);
  const minToMs = (s: string) => s ? Number(s) * 60000 : null;

  async function handleSave() {
    setSaving(true);
    await onSave(form);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="card p-5 space-y-5">
      <h3 className="text-sm font-bold text-white uppercase tracking-wider">⚙️ Configurações Globais</h3>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">

        <div>
          <label className="label block mb-1">Máx. contas ativas</label>
          <input className="input" type="number" min={1} max={100} value={form.max_active}
            onChange={e => set("max_active", Number(e.target.value))} />
        </div>

        <div>
          <label className="label block mb-1">Score mínimo (%)</label>
          <input className="input" type="number" min={0} max={100} value={form.min_health_score}
            onChange={e => set("min_health_score", Number(e.target.value))} />
        </div>

        <div>
          <label className="label block mb-1">Estratégia de rotação</label>
          <select className="input" value={form.rotation_strategy}
            onChange={e => set("rotation_strategy", e.target.value as RotationStrategy)}>
            {ROTATION_STRATEGIES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label block mb-1">Tempo máx. contínuo (min)</label>
          <input className="input" type="number" min={1} value={msToMin(form.max_continuous_ms)}
            onChange={e => set("max_continuous_ms", minToMs(e.target.value) ?? 7200000)} />
        </div>

        <div>
          <label className="label block mb-1">Cooldown pós uso (min)</label>
          <input className="input" type="number" min={0} value={msToMin(form.cooldown_after_use_ms)}
            onChange={e => set("cooldown_after_use_ms", minToMs(e.target.value) ?? 2700000)} />
        </div>

        <div>
          <label className="label block mb-1">Cooldown pós falha (min)</label>
          <input className="input" type="number" min={0} value={msToMin(form.cooldown_after_fail_ms)}
            onChange={e => set("cooldown_after_fail_ms", minToMs(e.target.value) ?? 1800000)} />
        </div>

        <div>
          <label className="label block mb-1">Quarentena (min)</label>
          <input className="input" type="number" min={0} value={msToMin(form.quarantine_ms)}
            onChange={e => set("quarantine_ms", minToMs(e.target.value) ?? 3600000)} />
        </div>

        <div>
          <label className="label block mb-1">Intervalo health check (seg)</label>
          <input className="input" type="number" min={10} value={form.health_check_interval_ms / 1000}
            onChange={e => set("health_check_interval_ms", Number(e.target.value) * 1000)} />
        </div>

        <div>
          <label className="label block mb-1">Validação de sessão (min)</label>
          <input className="input" type="number" min={1} value={msToMin(form.session_validation_interval_ms)}
            onChange={e => set("session_validation_interval_ms", minToMs(e.target.value) ?? 120000)} />
        </div>

        <div>
          <label className="label block mb-1">Validação de token (min)</label>
          <input className="input" type="number" min={1} value={msToMin(form.token_validation_interval_ms)}
            onChange={e => set("token_validation_interval_ms", minToMs(e.target.value) ?? 300000)} />
        </div>

        <div>
          <label className="label block mb-1">Reauth preventivo (h)</label>
          <input className="input" type="number" min={1} value={form.reauth_preventive_ms / 3600000}
            onChange={e => set("reauth_preventive_ms", Number(e.target.value) * 3600000)} />
        </div>
      </div>

      {/* Modo de tempo */}
      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.auto_time_mode}
            onChange={e => set("auto_time_mode", e.target.checked)}
            className="w-4 h-4 rounded border-white/20 bg-navy-950 text-accent" />
          <span className="text-sm text-slate-300">Modo automático de tempo de uso (global)</span>
        </label>
        <p className="text-xs text-slate-500 mt-1 ml-6">O bot decide dinamicamente o tempo ideal de permanência de cada conta.</p>
      </div>

      {!form.auto_time_mode && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1">Tempo mínimo global (min)</label>
            <input className="input" type="number" min={0} value={msToMin(form.min_use_ms)}
              onChange={e => set("min_use_ms", minToMs(e.target.value))} placeholder="ex: 30" />
          </div>
          <div>
            <label className="label block mb-1">Tempo máximo global (min)</label>
            <input className="input" type="number" min={0} value={msToMin(form.max_use_ms)}
              onChange={e => set("max_use_ms", minToMs(e.target.value))} placeholder="ex: 120" />
          </div>
        </div>
      )}

      {/* Toggles */}
      <div className="grid grid-cols-3 gap-3">
        {([
          ["auto_rotation", "Auto-rotação", "Ativa rotação automática de contas"],
          ["auto_refresh",  "Auto-refresh",  "Atualiza token/sessão automaticamente"],
          ["auto_relogin",  "Auto-relogin",  "Tenta relogin via email/senha (fallback)"],
        ] as const).map(([key, label, desc]) => (
          <div key={key} className="rounded-xl bg-white/5 ring-1 ring-white/10 p-3">
            <label className="flex items-center justify-between gap-2 cursor-pointer">
              <div>
                <p className="text-xs font-semibold text-slate-200">{label}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{desc}</p>
              </div>
              <input type="checkbox" checked={form[key]}
                onChange={e => set(key, e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-navy-950 text-accent" />
            </label>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Salvando..." : saved ? "✓ Salvo" : "Salvar configurações"}
        </button>
      </div>
    </div>
  );
}

// ─── Logs Panel ───────────────────────────────────────────────────────────────

function LogsPanel({
  logs,
  filterAccountId,
  onFilterChange,
  accounts,
}: {
  logs: AccountLog[];
  filterAccountId: number | null;
  onFilterChange: (id: number | null) => void;
  accounts: Account[];
}) {
  const [search, setSearch] = useState("");
  const [filterEvent, setFilterEvent] = useState("");

  const filtered = logs.filter(l => {
    if (filterAccountId && l.account_id !== filterAccountId) return false;
    if (filterEvent && l.event_type !== filterEvent) return false;
    if (search && !`${l.account_name ?? ""} ${l.detail ?? ""} ${l.event_type}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const eventTypes = [...new Set(logs.map(l => l.event_type))].sort();

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white uppercase tracking-wider">📋 Logs Operacionais</h3>
        <span className="text-xs text-slate-500">{filtered.length} registros</span>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <input
          className="input flex-1 min-w-[160px] text-xs py-1.5"
          placeholder="Buscar..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="input w-40 text-xs py-1.5" value={filterAccountId ?? ""} onChange={e => onFilterChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Todas as contas</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.nickname}</option>)}
        </select>
        <select className="input w-40 text-xs py-1.5" value={filterEvent} onChange={e => setFilterEvent(e.target.value)}>
          <option value="">Todos os eventos</option>
          {eventTypes.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <button className="btn-secondary text-xs" onClick={() => { setSearch(""); setFilterEvent(""); onFilterChange(null); }}>
          Limpar
        </button>
      </div>

      {/* Log entries */}
      <div className="space-y-0.5 max-h-72 overflow-y-auto font-mono">
        {filtered.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-8">Nenhum log encontrado</p>
        ) : filtered.map(log => (
          <div key={log.id} className="flex items-start gap-2 py-1 px-2 rounded hover:bg-white/3 text-[11px] leading-5">
            <span className="text-slate-500 shrink-0 w-16">{fmtTs(log.ts)}</span>
            <span className={`shrink-0 font-bold w-24 ${LOG_EVENT_COLORS[log.event_type] ?? LOG_EVENT_COLORS.default}`}>
              [{log.event_type}]
            </span>
            {log.account_name && (
              <span className="text-sky-400 shrink-0">{log.account_name}</span>
            )}
            {log.detail && (
              <span className="text-slate-300 break-all">{log.detail}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Summary Bar ──────────────────────────────────────────────────────────────

function SummaryBar({ accounts }: { accounts: Account[] }) {
  const total = accounts.length;
  const active = accounts.filter(a => a.state === "ACTIVE").length;
  const standby = accounts.filter(a => ["STANDBY","IDLE","COOLING","RESERVED","WAITING"].includes(a.state)).length;
  const problems = accounts.filter(a => ["ERROR","DEAD","BANNED","INVALID_TOKEN","NEEDS_VERIFICATION","LOGIN_CHALLENGE","MANUAL_ACTION_REQUIRED"].includes(a.state)).length;
  const avgHealth = total ? Math.round(accounts.reduce((s, a) => s + a.health_score, 0) / total) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: "Total de contas", value: total, color: "text-slate-200" },
        { label: "Ativas agora", value: active, color: "text-emerald-400" },
        { label: "Em standby", value: standby, color: "text-sky-400" },
        { label: "Com problemas", value: problems, color: problems > 0 ? "text-rose-400" : "text-slate-400" },
      ].map(({ label, value, color }) => (
        <div key={label} className="card p-4 flex flex-col gap-1">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
          <p className={`text-2xl font-extrabold tabular-nums ${color}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Rotation Panel ───────────────────────────────────────────────────────────

const RESULT_META: Record<string, { label: string; color: string; dot: string }> = {
  success:  { label: "Sucesso",   color: "text-emerald-400", dot: "bg-emerald-400" },
  failover: { label: "Failover",  color: "text-orange-400",  dot: "bg-orange-400" },
  rollback: { label: "Rollback",  color: "text-amber-400",   dot: "bg-amber-400" },
  aborted:  { label: "Abortado",  color: "text-rose-400",    dot: "bg-rose-400" },
};

function fmsDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function RotationStatusCard({
  entry,
  onTrigger,
  triggering,
}: {
  entry: RotationStatusEntry;
  onTrigger: (instanceId: number) => void;
  triggering: boolean;
}) {
  const autoOk = entry.auto_rotation_enabled && entry.active_account_auto_rotation;
  const coolMs = entry.cooldown_remaining_ms;

  return (
    <div className={`card p-4 space-y-3 ${entry.in_progress ? "ring-2 ring-violet-400/40" : ""} ${entry.failover_active ? "ring-2 ring-orange-400/50" : ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white">{entry.instance_name}</span>
          {entry.in_progress && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-400/15 text-violet-300 ring-1 ring-violet-400/30 animate-pulse">
              ⟳ ROTACIONANDO
            </span>
          )}
          {entry.failover_active && !entry.in_progress && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-400/15 text-orange-300 ring-1 ring-orange-400/30">
              ⚡ FAILOVER
            </span>
          )}
        </div>
        <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ring-1 ${
          autoOk
            ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30"
            : "bg-slate-400/10 text-slate-400 ring-slate-400/20"
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${autoOk ? "bg-emerald-400" : "bg-slate-500"}`} />
          Auto-rotação {autoOk ? "ATIVA" : "INATIVA"}
        </div>
      </div>

      {/* Conta ativa */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">Conta ativa</span>
        <span className={entry.active_account_nickname ? "text-emerald-300 font-medium" : "text-slate-500 italic"}>
          {entry.active_account_nickname ?? "Nenhuma"}
        </span>
      </div>

      {/* Última rotação */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">Última rotação</span>
        <span className="text-slate-300">
          {entry.last_rotated_at ? fmtRelative(entry.last_rotated_at) : "Nunca"}
        </span>
      </div>

      {/* Motivo da última rotação */}
      {entry.last_reason_label && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Motivo</span>
          <span className="text-violet-300 font-medium">{entry.last_reason_label}</span>
        </div>
      )}

      {/* Cooldown restante */}
      {coolMs && coolMs > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Cooldown restante</span>
          <span className="text-cyan-300 font-mono">{fmsDuration(coolMs)}</span>
        </div>
      )}

      {/* Botão forçar rotação */}
      <button
        onClick={() => onTrigger(entry.instance_id)}
        disabled={entry.in_progress || triggering}
        className={`w-full text-xs py-1.5 rounded-lg font-semibold transition-colors ring-1 ${
          entry.in_progress || triggering
            ? "bg-white/5 text-slate-500 ring-white/10 cursor-not-allowed"
            : "bg-violet-500/15 text-violet-300 ring-violet-400/30 hover:bg-violet-500/25"
        }`}
      >
        {entry.in_progress ? "⟳ Em andamento..." : "⚡ Forçar rotação"}
      </button>
    </div>
  );
}

function RotationPanel({
  status,
  history,
  loading,
  onRefresh,
  onTrigger,
  triggeringInstance,
}: {
  status: RotationStatusEntry[];
  history: RotationHistoryEntry[];
  loading: boolean;
  onRefresh: () => void;
  onTrigger: (instanceId: number) => void;
  triggeringInstance: number | null;
}) {
  const autoRotEnabled = status.some(s => s.auto_rotation_enabled);

  if (loading) {
    return <div className="card p-12 text-center text-slate-500 text-sm">Carregando status de rotação...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ring-1 ${
            autoRotEnabled
              ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30"
              : "bg-slate-400/10 text-slate-400 ring-slate-400/20"
          }`}>
            <span className={`w-2 h-2 rounded-full ${autoRotEnabled ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
            Auto-rotação global: {autoRotEnabled ? "LIGADA" : "DESLIGADA"}
          </span>
          {!autoRotEnabled && (
            <span className="text-[11px] text-slate-500">
              Configure em ⚙️ Configurações → Auto-rotação
            </span>
          )}
        </div>
        <button onClick={onRefresh} className="btn-secondary text-[11px] py-1 px-2.5">
          ↻ Atualizar
        </button>
      </div>

      {/* Per-instance status cards */}
      {status.length === 0 ? (
        <div className="card p-12 text-center text-slate-500 text-sm">
          Nenhuma instância cadastrada.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {status.map(entry => (
            <RotationStatusCard
              key={entry.instance_id}
              entry={entry}
              onTrigger={onTrigger}
              triggering={triggeringInstance === entry.instance_id}
            />
          ))}
        </div>
      )}

      {/* Rotation history timeline */}
      <div className="card p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Histórico de rotações</p>

        {history.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-6">Nenhuma rotação registrada ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                  <th className="pb-2 text-left">Quando</th>
                  <th className="pb-2 text-left">Instância</th>
                  <th className="pb-2 text-left">De → Para</th>
                  <th className="pb-2 text-left">Motivo</th>
                  <th className="pb-2 text-left">Resultado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {history.map(h => {
                  const rm = RESULT_META[h.result] ?? { label: h.result, color: "text-slate-400", dot: "bg-slate-400" };
                  return (
                    <tr key={h.id} className="text-slate-300 hover:bg-white/3 transition-colors">
                      <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{fmtRelative(h.rotated_at)}</td>
                      <td className="py-2 pr-3 font-medium text-white whitespace-nowrap">{h.instance_name ?? `#${h.instance_id}`}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="text-slate-500">{h.old_account_name ?? "—"}</span>
                        <span className="text-slate-600 mx-1">→</span>
                        <span className={h.new_account_name ? "text-emerald-300" : "text-slate-500"}>{h.new_account_name ?? "—"}</span>
                      </td>
                      <td className="py-2 pr-3 text-violet-300 whitespace-nowrap">{h.reason}</td>
                      <td className="py-2">
                        <span className={`inline-flex items-center gap-1 ${rm.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${rm.dot}`} />
                          {rm.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Contas() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [logs, setLogs] = useState<AccountLog[]>([]);
  const [config, setConfig] = useState<AccountsConfig>(DEFAULT_CONFIG);
  const [tokens, setTokens] = useState<TokenPoolItem[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);

  const [filterState, setFilterState] = useState<AccountState | "">("");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterTier, setFilterTier] = useState("");
  const [sortKey, setSortKey] = useState<"health" | "name" | "state" | "tier">("health");

  const [pool, setPool] = useState<InstancePoolSummary[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);

  const [rotationStatus, setRotationStatus] = useState<RotationStatusEntry[]>([]);
  const [rotationHistory, setRotationHistory] = useState<RotationHistoryEntry[]>([]);
  const [rotationLoading, setRotationLoading] = useState(false);
  const [triggeringInstance, setTriggeringInstance] = useState<number | null>(null);

  const [tab, setTab] = useState<"accounts" | "pool" | "config" | "logs" | "rotation">("accounts");
  const [showForm, setShowForm] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [stateModal, setStateModal] = useState<{ id: number; state: AccountState } | null>(null);
  const [filterLogAccount, setFilterLogAccount] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const logsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [accs, cfg, toks, insts] = await Promise.all([
        api<Account[]>("/api/accounts"),
        api<AccountsConfig>("/api/accounts/config"),
        api<TokenPoolItem[]>("/api/tokens"),
        api<{ id: number; name: string }[]>("/api/instances"),
      ]);
      setAccounts(accs);
      if (cfg && Object.keys(cfg).length > 0) setConfig(cfg);
      setTokens(toks);
      setInstances(insts);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const l = await api<AccountLog[]>("/api/accounts/logs?limit=200");
      setLogs(l);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const loadPool = useCallback(async () => {
    setPoolLoading(true);
    try {
      const p = await api<InstancePoolSummary[]>("/api/accounts/pool-by-instance");
      setPool(p);
    } catch (e) {
      console.error(e);
    } finally {
      setPoolLoading(false);
    }
  }, []);

  const loadRotation = useCallback(async () => {
    setRotationLoading(true);
    try {
      const [st, hist] = await Promise.all([
        api<RotationStatusEntry[]>("/api/accounts/rotation-status"),
        api<RotationHistoryEntry[]>("/api/accounts/rotation-history?limit=50"),
      ]);
      setRotationStatus(st);
      setRotationHistory(hist);
    } catch (e) {
      console.error(e);
    } finally {
      setRotationLoading(false);
    }
  }, []);

  const handleTriggerRotation = useCallback(async (instanceId: number) => {
    setTriggeringInstance(instanceId);
    try {
      await api(`/api/accounts/rotation-trigger/${instanceId}`, { method: "POST" });
      setTimeout(loadRotation, 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setTriggeringInstance(null);
    }
  }, [loadRotation]);

  useEffect(() => {
    loadAll();
    loadLogs();
    loadPool();
    loadRotation();
    const interval = setInterval(loadAll, 15000);
    logsIntervalRef.current = setInterval(loadLogs, 10000);
    const rotInterval = setInterval(loadRotation, 15000);
    return () => {
      clearInterval(interval);
      clearInterval(rotInterval);
      if (logsIntervalRef.current) clearInterval(logsIntervalRef.current);
    };
  }, [loadAll, loadLogs, loadRotation]);

  async function handleAction(id: number, action: string) {
    setActionLoading(id);
    try {
      await api(`/api/accounts/${id}/${action}`, { method: "POST" });
      await Promise.all([loadAll(), loadLogs()]);
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSaveAccount(data: Record<string, unknown>) {
    if (editAccount?.id) {
      await api(`/api/accounts/${editAccount.id}`, { method: "PUT", body: JSON.stringify(data) });
    } else {
      await api("/api/accounts", { method: "POST", body: JSON.stringify(data) });
    }
    setShowForm(false);
    setEditAccount(null);
    await loadAll();
  }

  async function handleSaveConfig(cfg: AccountsConfig) {
    await api("/api/accounts/config", { method: "PUT", body: JSON.stringify(cfg) });
    setConfig(cfg);
  }

  async function handleStateChange(state: AccountState, reason: string) {
    if (!stateModal) return;
    await api(`/api/accounts/${stateModal.id}/state`, {
      method: "POST",
      body: JSON.stringify({ state, reason }),
    });
    setStateModal(null);
    await Promise.all([loadAll(), loadLogs()]);
  }

  // Filter + sort
  const filtered = accounts
    .filter(a => {
      if (filterState && a.state !== filterState) return false;
      if (filterTier && a.tier !== filterTier) return false;
      if (filterSearch && !`${a.nickname} ${a.email ?? ""} ${a.instance_name ?? ""}`.toLowerCase().includes(filterSearch.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "health") return b.health_score - a.health_score;
      if (sortKey === "name") return a.nickname.localeCompare(b.nickname);
      if (sortKey === "state") return a.state.localeCompare(b.state);
      if (sortKey === "tier") return a.tier.localeCompare(b.tier);
      return 0;
    });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">
        Carregando contas...
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 lg:px-10 py-8">
      <div className="mx-auto max-w-6xl space-y-6">

        {/* Header */}
        <div className="card p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <a href="/" className="text-slate-500 hover:text-slate-300 transition-colors text-xs border border-white/10 rounded-lg px-3 py-1.5">
              ← Voltar
            </a>
            <h1 className="text-xl font-extrabold text-white tracking-tight">
              <span className="bg-gradient-to-r from-cyan-300 to-sky-400 bg-clip-text text-transparent">CONTAS</span>
            </h1>
            <span className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Account Manager</span>
          </div>
          <button
            onClick={() => { setEditAccount(null); setShowForm(true); }}
            className="btn-primary text-sm"
          >
            + Nova conta
          </button>
        </div>

        {/* Summary */}
        <SummaryBar accounts={accounts} />

        {/* Tabs */}
        <div className="flex gap-2 flex-wrap">
          {([
            { key: "accounts", label: "👤 Contas" },
            { key: "pool",     label: "🏊 Pool" },
            { key: "rotation", label: "🔄 Rotação" },
            { key: "config",   label: "⚙️ Configurações" },
            { key: "logs",     label: `📋 Logs (${logs.length})` },
          ] as const).map(t => (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                if (t.key === "pool") loadPool();
                if (t.key === "rotation") loadRotation();
              }}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                tab === t.key
                  ? "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-400/30"
                  : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Accounts Tab ── */}
        {tab === "accounts" && (
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex gap-2 flex-wrap">
              <input
                className="input flex-1 min-w-[180px] text-xs py-2"
                placeholder="Buscar por nome, email ou instância..."
                value={filterSearch}
                onChange={e => setFilterSearch(e.target.value)}
              />
              <select className="input w-44 text-xs py-2" value={filterState} onChange={e => setFilterState(e.target.value as AccountState | "")}>
                <option value="">Todos os estados</option>
                {ALL_STATES.map(s => <option key={s} value={s}>{STATE_META[s].label}</option>)}
              </select>
              <select className="input w-28 text-xs py-2" value={filterTier} onChange={e => setFilterTier(e.target.value)}>
                <option value="">Todos os tiers</option>
                {["S","A","B","C","D"].map(t => <option key={t} value={t}>Tier {t}</option>)}
              </select>
              <select className="input w-36 text-xs py-2" value={sortKey} onChange={e => setSortKey(e.target.value as typeof sortKey)}>
                <option value="health">↓ Health Score</option>
                <option value="name">Nome A-Z</option>
                <option value="state">Estado</option>
                <option value="tier">Tier</option>
              </select>
              {(filterSearch || filterState || filterTier) && (
                <button className="btn-secondary text-xs" onClick={() => { setFilterSearch(""); setFilterState(""); setFilterTier(""); }}>
                  Limpar filtros
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-slate-500 text-sm">
                  {accounts.length === 0
                    ? "Nenhuma conta cadastrada. Clique em \"+ Nova conta\" para começar."
                    : "Nenhuma conta encontrada com os filtros aplicados."}
                </p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map(account => (
                  <div key={account.id} className={actionLoading === account.id ? "opacity-60 pointer-events-none" : ""}>
                    <AccountCard
                      account={account}
                      onAction={handleAction}
                      onEdit={a => { setEditAccount(a); setShowForm(true); }}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Pool overview */}
            {accounts.length > 0 && (
              <div className="card p-4">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">Pool de contas — distribuição</p>
                <div className="flex gap-1.5 flex-wrap">
                  {ALL_STATES.map(s => {
                    const count = accounts.filter(a => a.state === s).length;
                    if (count === 0) return null;
                    const m = STATE_META[s];
                    return (
                      <span key={s} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${m.color} ${m.bg} ring-1 ${m.ring}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
                        {m.label}: {count}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Pool Tab ── */}
        {tab === "pool" && (
          <PoolPanel
            pool={pool}
            loading={poolLoading}
            onRefresh={loadPool}
            onGoToAccount={(id) => {
              setTab("accounts");
              setFilterSearch(accounts.find(a => a.id === id)?.nickname ?? "");
            }}
          />
        )}

        {/* ── Rotation Tab ── */}
        {tab === "rotation" && (
          <RotationPanel
            status={rotationStatus}
            history={rotationHistory}
            loading={rotationLoading}
            onRefresh={loadRotation}
            onTrigger={handleTriggerRotation}
            triggeringInstance={triggeringInstance}
          />
        )}

        {/* ── Config Tab ── */}
        {tab === "config" && (
          <ConfigPanel config={config} onSave={handleSaveConfig} />
        )}

        {/* ── Logs Tab ── */}
        {tab === "logs" && (
          <LogsPanel
            logs={logs}
            filterAccountId={filterLogAccount}
            onFilterChange={setFilterLogAccount}
            accounts={accounts}
          />
        )}

      </div>

      {/* Modals */}
      {showForm && (
        <AccountForm
          initial={editAccount}
          tokens={tokens}
          instances={instances}
          onSave={handleSaveAccount}
          onCancel={() => { setShowForm(false); setEditAccount(null); }}
        />
      )}
      {stateModal && (
        <StateModal
          accountId={stateModal.id}
          current={stateModal.state}
          onSave={handleStateChange}
          onCancel={() => setStateModal(null)}
        />
      )}
    </div>
  );
}
