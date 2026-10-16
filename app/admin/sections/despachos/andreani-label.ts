import { supabase } from "@/lib/supabase/client"

/**
 * Abre (para imprimir) o descarga la etiqueta Andreani de un pedido. Imprimirla
 * desde Despachos identifica el pedido para el Bulto general.
 */
export async function openAndreaniLabel(orderId: number, mode: "print" | "download") {
  // La ventana se abre antes del fetch: si no, el navegador la bloquea.
  const labelWindow = mode === "print" ? window.open("", "_blank") : null
  if (labelWindow) labelWindow.opener = null
  try {
    const { data } = await supabase.auth.getSession()
    if (!data.session?.access_token) throw new Error("Tu sesión venció. Volvé a ingresar.")
    const response = await fetch(`/api/admin/dispatch/orders/${orderId}/andreani-label`, {
      method: "POST",
      headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ formato: "pdf" }),
      cache: "no-store",
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(payload?.error ?? "No se pudo obtener la etiqueta Andreani.")
    }
    const blobUrl = URL.createObjectURL(await response.blob())
    if (mode === "download") {
      const link = document.createElement("a")
      link.href = blobUrl
      link.download = `andreani-${orderId}.pdf`
      link.click()
    } else if (labelWindow) {
      // El "load" se escucha después de navegar: si no, puede dispararse con about:blank.
      labelWindow.location.href = blobUrl
      labelWindow.addEventListener("load", () => labelWindow.print(), { once: true })
    } else {
      throw new Error("El navegador bloqueó la ventana de la etiqueta. Usá Descargar etiqueta.")
    }
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  } catch (error) {
    labelWindow?.close()
    throw error
  }
}
