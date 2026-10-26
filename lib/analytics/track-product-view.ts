import { claimProductView, settleProductView } from "./product-view-state"
import { PRODUCT_VIEW_ENDPOINT, type ProductViewSource } from "./events"

const SEND_TIMEOUT_MS = 5_000

/**
 * Token de la sesión, si hay. El cliente Supabase se importa diferido: si no
 * pudiera inicializarse, la vista se envía igual como anónima y la página del
 * producto ni se entera.
 */
async function getAccessToken() {
  try {
    const { supabase } = await import("@/lib/supabase/client")
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  } catch {
    return null
  }
}

/**
 * Envía el `product_view` fuera del camino crítico: nunca lanza, nunca se
 * espera y cualquier fallo (red, storage, auth, servidor) se descarta. El
 * token sólo viaja para que el servidor identifique al usuario por su cuenta;
 * el payload no lleva datos de usuario.
 *
 * Una respuesta del servidor (2xx) o un rechazo del payload (4xx, que no se
 * arregla reintentando) cierran el envío; red caída, timeout o 5xx lo dejan
 * para reintentar la próxima vez que se abra el producto.
 */
export async function sendProductView(productId: number, source: ProductViewSource) {
  let claim: { sessionId: string } | null = null
  let delivered = false
  try {
    claim = claimProductView(productId)
    if (!claim) return

    const token = await getAccessToken()
    const response = await fetch(PRODUCT_VIEW_ENDPOINT, {
      method: "POST",
      keepalive: true,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ sessionId: claim.sessionId, productId, source }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    delivered = response.status < 500
  } catch {
    // Analítica nunca interfiere con la navegación ni con la compra.
  } finally {
    if (claim) {
      try {
        settleProductView(productId, claim.sessionId, delivered)
      } catch {
        // Sin storage ni memoria utilizable: sólo se pierde el reintento.
      }
    }
  }
}
