import { useCallback, useEffect, useRef, useState } from "react";
import type { InstanceState } from "@shared/types";
import { api } from "@/lib/api";
import { Header } from "@/components/Header";
import { ControlPanel } from "@/components/ControlPanel";
import { StatsGrid } from "@/components/StatsGrid";
import { ConfigForm } from "@/components/ConfigForm";
import { LogsConsole } from "@/components/LogsConsole";
import { BlacklistPanel } from "@/components/BlacklistPanel";
import { SendErrorsPanel } from "@/components/SendErrorsPanel";

export function App() {
  const [instances, setInstances] = useState<InstanceState[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const wsRefs = useRef<Map<number, WebSocket>>(new Map());

  const instance = instances[activeIdx] ?? null;

  async function reload() {
    try {
      const list = await api<InstanceState[]>("/api/instances");
      setInstances(list);
    } catch (e) {
      console.error(e);
    }
  }

  // Connect WebSocket for each instance and listen for stats updates
  const connectWs = useCallback((inst: InstanceState) => {
    if (wsRefs.current.has(inst.id)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${inst.id}`);
    wsRefs.current.set(inst.id, ws);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "stats") {
          const p = msg.payload;
          setInstances((prev) =>
            prev.map((item) =>
              item.id === inst.id
                ? {
                    ...item,
                    running: p.running ?? item.running,
                    connected: p.connected ?? item.connected,
                    user_handle: p.user_handle ?? item.user_handle,
                    uptime_seconds: p.uptime_seconds ?? item.uptime_seconds,
                    next_rotation_seconds:
                      p.next_rotation_seconds ?? item.next_rotation_seconds,
                    stats: {
                      entradas: p.entradas ?? item.stats.entradas,
                      na_fila: p.na_fila ?? item.stats.na_fila,
                      partidas: p.partidas ?? item.stats.partidas,
                      dms: p.dms ?? item.stats.dms,
                      bloqueadas: p.bloqueadas ?? item.stats.bloqueadas,
                      msgs_enviadas: p.msgs_enviadas ?? item.stats.msgs_enviadas,
                    },
                  }
                : item,
            ),
          );
        }
      } catch { /* noop */ }
    };

    ws.onclose = () => {
      wsRefs.current.delete(inst.id);
      // Reconnect after 3s
      setTimeout(() => {
        if (wsRefs.current.has(inst.id)) return;
        connectWs(inst);
      }, 3000);
    };
    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    for (const inst of instances) {
      connectWs(inst);
    }
  }, [instances.map((i) => i.id).join(",")]);

  useEffect(() => {
    return () => {
      for (const ws of wsRefs.current.values()) {
        ws.close();
      }
    };
  }, []);

  async function toggle() {
    if (!instance) return;
    const path = instance.running
      ? `/api/instances/${instance.id}/stop`
      : `/api/instances/${instance.id}/start`;
    await api(path, { method: "POST" });
    reload();
  }

  async function resetStats() {
    if (!instance) return;
    await api(`/api/instances/${instance.id}/reset-stats`, { method: "POST" });
    reload();
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 lg:px-10 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Instance tabs */}
        {instances.length > 1 && (
          <div className="flex gap-2">
            {instances.map((inst, idx) => (
              <button
                key={inst.id}
                onClick={() => setActiveIdx(idx)}
                className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  idx === activeIdx
                    ? "bg-emerald-500 text-black"
                    : "bg-white/10 text-slate-300 hover:bg-white/20"
                }`}
              >
                {inst.name}
                {inst.running && (
                  <span className="ml-2 inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                )}
              </button>
            ))}
          </div>
        )}

        <Header instance={instance} />

        <div className="grid lg:grid-cols-2 gap-6">
          <ControlPanel instance={instance} onToggle={toggle} />
          <StatsGrid instance={instance} onResetStats={resetStats} />
        </div>

        {instance && (
          <ConfigForm
            instanceId={instance.id}
            running={instance.running}
            onSaved={reload}
          />
        )}
        {instance && <BlacklistPanel instanceId={instance.id} />}
        {instance && <SendErrorsPanel instanceId={instance.id} />}
        {instance && <LogsConsole instanceId={instance.id} />}

        <p className="text-center text-xs text-slate-500 pt-2 pb-6">
          Use por sua conta e risco. Selfbots violam os Termos de Serviço do Discord.
        </p>
      </div>
    </div>
  );
}
