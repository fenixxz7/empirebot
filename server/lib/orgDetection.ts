/**
 * Módulo singleton para rastreamento em memória do tipo de partida detectado por org.
 * Sobrevive entre chamadas mas é limpo no restart do servidor.
 * Chave: `${instanceId}:${orgId}`
 */

export type DetectedMatchType = "thread" | "private_channel";

// ─── Contadores de ghost por tipo ────────────────────────────────────────────
// Chave: `${instanceId}:${matchType}`
const ghostsByType = new Map<string, number>();

export function recordGhostByType(instanceId: number, matchType: string): void {
  const key = `${instanceId}:${matchType}`;
  ghostsByType.set(key, (ghostsByType.get(key) ?? 0) + 1);
}

export function getGhostsByType(instanceId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of ghostsByType.entries()) {
    const [iid, mt] = key.split(":");
    if (Number(iid) === instanceId) out[mt] = (out[mt] ?? 0) + count;
  }
  return out;
}

// ─── Contadores de sem-correlação (match sem activeQueue) ────────────────────
const uncorrelatedByInstance = new Map<number, number>();

/** Registra uma partida detectada que não encontrou activeQueue correspondente. */
export function recordUncorrelated(instanceId: number): void {
  uncorrelatedByInstance.set(instanceId, (uncorrelatedByInstance.get(instanceId) ?? 0) + 1);
}

export function getUncorrelatedCount(instanceId: number): number {
  return uncorrelatedByInstance.get(instanceId) ?? 0;
}

export interface OrgDetectionEvent {
  orgId: number;
  orgName: string;
  detectedType: DetectedMatchType;
  configuredType: string;
  channelId: string;
  channelName: string;
  detectedAt: number;
  /** Quantas vezes este tipo foi detectado na sessão atual */
  threadCount: number;
  privateCount: number;
}

const detectionMap = new Map<string, OrgDetectionEvent>();

function makeKey(instanceId: number, orgId: number): string {
  return `${instanceId}:${orgId}`;
}

export function recordDetectedType(
  instanceId: number,
  data: Omit<OrgDetectionEvent, 'threadCount' | 'privateCount'>,
): void {
  const key = makeKey(instanceId, data.orgId);
  const prev = detectionMap.get(key);
  const threadCount = (prev?.threadCount ?? 0) + (data.detectedType === 'thread' ? 1 : 0);
  const privateCount = (prev?.privateCount ?? 0) + (data.detectedType === 'private_channel' ? 1 : 0);
  detectionMap.set(key, { ...data, threadCount, privateCount });
}

export function getDetectedType(instanceId: number, orgId: number): OrgDetectionEvent | undefined {
  return detectionMap.get(makeKey(instanceId, orgId));
}

/** Retorna todos os eventos detectados como lista para a API. */
export function listDetectedTypes(): Array<OrgDetectionEvent & { instance_id: number; org_id: number }> {
  return [...detectionMap.entries()].map(([key, v]) => {
    const [instanceId] = key.split(':');
    return { ...v, instance_id: Number(instanceId), org_id: v.orgId };
  });
}

/** Limpa todos os dados de detecção para uma instância (ex: ao reiniciar). */
export function clearInstanceDetection(instanceId: number): void {
  for (const key of detectionMap.keys()) {
    if (key.startsWith(`${instanceId}:`)) detectionMap.delete(key);
  }
}

/**
 * Retorna o tipo dominante detectado para uma org 'mixed'.
 * Considera apenas as últimas N detecções para decidir o pipeline prioritário.
 */
export function getDominantType(instanceId: number, orgId: number): DetectedMatchType | null {
  const ev = detectionMap.get(makeKey(instanceId, orgId));
  if (!ev) return null;
  if (ev.threadCount === 0 && ev.privateCount === 0) return null;
  return ev.threadCount >= ev.privateCount ? 'thread' : 'private_channel';
}
