import { useEffect, useState } from "react";
import type { InstanceState } from "@shared/types";
import { api } from "@/lib/api";
import { Header } from "@/components/Header";
import { ControlPanel } from "@/components/ControlPanel";
import { StatsGrid } from "@/components/StatsGrid";
import { ConfigForm } from "@/components/ConfigForm";
import { LogsConsole } from "@/components/LogsConsole";

export function App() {
  const [instance, setInstance] = useState<InstanceState | null>(null);

  async function reload() {
    try {
      const list = await api<InstanceState[]>("/api/instances");
      setInstance(list[0] ?? null);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    reload();
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
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
        {instance && <LogsConsole instanceId={instance.id} />}

        <p className="text-center text-xs text-slate-500 pt-2 pb-6">
          Use por sua conta e risco. Selfbots violam os Termos de Serviço do Discord.
        </p>
      </div>
    </div>
  );
}
