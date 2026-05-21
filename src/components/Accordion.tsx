import { useState, useRef, useEffect } from "react";

interface AccordionProps {
  title: string;
  icon?: React.ReactNode;
  badge?: string | number | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
  danger?: boolean;
}

export function Accordion({
  title,
  icon,
  badge,
  defaultOpen = false,
  children,
  danger = false,
}: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<string>(defaultOpen ? "auto" : "0px");

  useEffect(() => {
    if (!bodyRef.current) return;
    if (open) {
      const h = bodyRef.current.scrollHeight;
      setHeight(`${h}px`);
      const id = setTimeout(() => setHeight("auto"), 280);
      return () => clearTimeout(id);
    } else {
      setHeight(`${bodyRef.current.scrollHeight}px`);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setHeight("0px"));
      });
    }
  }, [open]);

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={[
          "w-full flex items-center gap-3 px-4 sm:px-5 py-3.5 text-left transition-colors",
          open ? "bg-white/[0.025]" : "hover:bg-white/[0.02]",
        ].join(" ")}
      >
        {icon && (
          <span className={danger ? "text-rose-400" : "text-accent"}>
            {icon}
          </span>
        )}
        <span
          className={[
            "flex-1 text-sm font-semibold",
            danger ? "text-rose-300" : "text-slate-200",
          ].join(" ")}
        >
          {title}
        </span>
        {badge != null && badge !== 0 && (
          <span
            className={[
              "text-[10px] font-bold px-2 py-px rounded-full ring-1",
              danger
                ? "text-rose-300 bg-rose-400/10 ring-rose-400/25"
                : "text-accent bg-accent/10 ring-accent/25",
            ].join(" ")}
          >
            {badge}
          </span>
        )}
        <ChevronIcon
          className={[
            "w-4 h-4 text-slate-500 shrink-0 transition-transform duration-200",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>

      <div
        ref={bodyRef}
        style={{ height, overflow: "hidden", transition: "height 260ms cubic-bezier(0.4,0,0.2,1)" }}
      >
        <div className="border-t border-white/[0.04]">{children}</div>
      </div>
    </div>
  );
}

function ChevronIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
