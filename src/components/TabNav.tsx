export type MainTab = "fila" | "dm" | "org";

const TABS: { key: MainTab; label: string; path: string }[] = [
  { key: "fila", label: "BOT FILA", path: "/" },
  { key: "dm",   label: "BOT DM",   path: "/messages" },
  { key: "org",  label: "BOT ORG",  path: "/org-joiner" },
];

export function TabNav({ active }: { active: MainTab }) {
  return (
    <div className="flex gap-1.5">
      {TABS.map((t) => (
        <a
          key={t.key}
          href={t.path}
          className={[
            "px-5 py-2 rounded-xl text-xs font-semibold tracking-wide transition-all",
            t.key === active
              ? "bg-white text-slate-900 shadow"
              : "bg-white/[0.05] text-slate-400 hover:text-white hover:bg-white/[0.08]",
          ].join(" ")}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}
