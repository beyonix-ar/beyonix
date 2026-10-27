import { isUuid } from "./commerce-event.ts"

/** Mínimo del cliente de Supabase que usa el vínculo (service_role). */
interface OrderSessionWriter {
  from: (table: "analytics_order_sessions") => {
    upsert: (
      row: { order_id: number; session_id: string },
      options: { onConflict: string; ignoreDuplicates: boolean },
    ) => PromiseLike<{ error: { code?: string } | null }>
  }
}

/**
 * Vincula la orden recién creada con la sesión de Analítica del navegador
 * (server-side, con service_role; el público no puede escribir esta tabla).
 * Así la compra confirmada después (trigger de `ordenes`) se atribuye a la
 * sesión del funnel. Nunca lanza ni demora el checkout con errores: una orden
 * sin sesión sigue siendo una compra completada, sólo no es atribuible.
 * Primera sesión gana (un reintento del mismo pedido no la cambia).
 */
export async function linkOrderAnalyticsSession(admin: OrderSessionWriter, orderId: number, analyticsSessionId: unknown) {
  if (!isUuid(analyticsSessionId) || !Number.isSafeInteger(orderId) || orderId <= 0) return
  try {
    const { error } = await admin
      .from("analytics_order_sessions")
      .upsert({ order_id: orderId, session_id: analyticsSessionId.toLowerCase() }, { onConflict: "order_id", ignoreDuplicates: true })
    if (error) console.warn("[analytics] sesión de la orden no vinculada", { code: error.code })
  } catch (error) {
    console.warn("[analytics] sesión de la orden no vinculada", {
      message: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    })
  }
}
