/**
 * Módulo singleton para rastreamento em memória do tipo de partida detectado por org.
 * Sobrevive entre chamadas mas é limpo no restart do servidor.
 * Chave: `${instanceId}:${orgId}`
 */

export type DetectedMatchType = 'thread' | 'private_channel';

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
