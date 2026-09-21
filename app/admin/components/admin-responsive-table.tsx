"use client"
import { useId, type ReactNode } from "react"

/** Keeps native table semantics on desktop and labelled rows on small notebooks. */
export function AdminResponsiveTable({ labels, children }: { labels: string[]; children: ReactNode }) {
  const scope = `admin-table-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  return <div className={scope}>
    <style>{`@media (max-width: 1535px) {
      .${scope} table { min-width: 0 !important; width: 100%; }
      .${scope} thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      .${scope} tbody { display: block; }
      .${scope} tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: .5rem; border: 1px solid var(--admin-border, #ffffff20); border-radius: .75rem; padding: .5rem; }
      .${scope} td { display: block; width: auto !important; min-width: 0 !important; max-width: none !important; white-space: normal !important; text-align: left !important; overflow-wrap: anywhere; padding: .5rem !important; }
      .${scope} td[colspan] { grid-column: 1 / -1; }
      .${scope} td:not([colspan])::before { display: block; font-size: .625rem; font-weight: 700; opacity: .7; margin-bottom: .25rem; }
      ${labels.map((label, index) => `.${scope} td:nth-child(${index + 1}):not([colspan])::before { content: ${JSON.stringify(label)}; }`).join("\n")}
    }
    @media (max-width: 480px) { .${scope} tbody tr { grid-template-columns: minmax(0, 1fr); } }`}</style>
    {children}
  </div>
}
