import { supabase } from "@/lib/supabase/client"

/**
 * Abre la etiqueta PDF de un tramo del reclamo (sólo Admin). Devuelve un
 * mensaje de error para mostrar, o null si se abrió.
 */
export async function openClaimShipmentLabel(claimId: number, shipmentId: number): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return "La sesión administrativa venció."
  const response = await fetch(`/api/admin/order-claims/${claimId}/andreani-shipment?shipmentId=${shipmentId}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    return data.error || "No se pudo obtener la etiqueta."
  }
  const url = URL.createObjectURL(await response.blob())
  window.open(url, "_blank", "noopener")
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return null
}
