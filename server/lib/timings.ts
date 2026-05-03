/**
 * Constantes de tempo centralizadas (em milissegundos).
 *
 * Antes estavam espalhadas como números mágicos (`4 * 60 * 1000`) em vários
 * arquivos. Centralizar facilita ajuste fino e evita drift entre módulos.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** TTL de uma fila ativa antes do sweep considerar abandonada. */
export const ACTIVE_QUEUE_TTL_MS = 4 * MINUTE_MS;

/** Cooldown após receber automod (Discord 200000). */
export const COOLDOWN_AUTOMOD_MS = 10 * MINUTE_MS;

/** Cooldown após receber 340013 (acesso restringido). */
export const COOLDOWN_RESTRICTED_MS = 20 * MINUTE_MS;

/** Validade do cookie de sessão. */
export const SESSION_COOKIE_MAX_AGE_MS = 7 * DAY_MS;

/** Intervalo de rotação de logs antigos. */
export const LOG_ROTATION_INTERVAL_MS = 6 * HOUR_MS;
