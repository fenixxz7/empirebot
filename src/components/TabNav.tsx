export type MainTab = "fila" | "org";

const TABS: { key: MainTab; label: string }[] = [
  { key: "fila", label: "BOT FILA" },
  { key: "org",  label: "BOT ORG"  },
];

export function TabNav({
  active,
  onChange,
}: {
  active: MainTab;
  onChange: (tab: MainTab) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {TABS.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={[
            "px-5 py-2 rounded-xl text-xs font-semibold tracking-wide transition-all",
            t.key === active
              ? "bg-white text-slate-900 shadow"
              : "bg-white/[0.05] text-slate-400 hover:text-white hover:bg-white/[0.08]",
          ].join(" ")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
