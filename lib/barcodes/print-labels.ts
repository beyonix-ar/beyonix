import { supabase } from "@/lib/supabase/client"

import { buildLabelsDocument, type LabelFormat, type PrintableLabel } from "./labels-document"

async function fetchBarcodeSvgs(codes: string[]) {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error("Tu sesión venció. Volvé a ingresar.")
  const response = await fetch("/api/admin/barcodes", {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ codes }),
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as { svgs?: Record<string, string>; error?: string } | null
  if (!response.ok || !payload?.svgs) throw new Error(payload?.error ?? "No se pudieron generar las etiquetas.")
  return payload.svgs
}

export async function printLabels(labels: readonly PrintableLabel[], format: LabelFormat = "a4") {
  if (!labels.length) throw new Error("No hay etiquetas para imprimir.")
  const svgs = await fetchBarcodeSvgs([...new Set(labels.map((label) => label.code))])
  await printHtmlDocument(buildLabelsDocument(labels, svgs, format))
}

// Imprime desde un iframe aislado: la página del admin no cambia y el diálogo
// de impresión recibe sólo la hoja de etiquetas.
export function printHtmlDocument(html: string) {
  return new Promise<void>((resolve, reject) => {
    const frame = document.createElement("iframe")
    frame.setAttribute("aria-hidden", "true")
    frame.tabIndex = -1
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none"
    const cleanup = () => window.setTimeout(() => frame.remove(), 1000)
    frame.onload = () => {
      const target = frame.contentWindow
      if (!target) { frame.remove(); reject(new Error("No se pudo abrir la impresión.")); return }
      target.addEventListener("afterprint", cleanup, { once: true })
      window.setTimeout(cleanup, 5 * 60_000)
      target.focus()
      target.print()
      resolve()
    }
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}
