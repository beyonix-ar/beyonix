import { createAdminClient } from "../supabase/admin.ts"
import {
  LOCAL_DELIVERY_SETTINGS_KEY,
  normalizeStoredLocalDeliverySettings,
  type LocalDeliverySettings,
} from "./local-delivery.ts"

export class LocalDeliverySettingsUnavailableError extends Error {
  constructor() {
    super("No se pudo leer la configuración de Envío BEYONIX.")
    this.name = "LocalDeliverySettingsUnavailableError"
  }
}

/**
 * Lectura sin caché y estricta (con el costo interno): la usan Admin y la
 * creación de pedidos. Si la base falla no se valida un envío con valores
 * supuestos; una clave nunca guardada equivale a la configuración inicial.
 */
export async function getLocalDeliverySettings(
  admin: ReturnType<typeof createAdminClient> = createAdminClient(),
): Promise<LocalDeliverySettings> {
  const { data, error } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", LOCAL_DELIVERY_SETTINGS_KEY)
    .maybeSingle()
  if (error) throw new LocalDeliverySettingsUnavailableError()
  // Sin fila = nunca configurada (valores iniciales); fila inválida = desactivada.
  return normalizeStoredLocalDeliverySettings(data?.value, data !== null)
}
