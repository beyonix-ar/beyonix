export function humanizeBillingError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "")
  if (/sesión|permisos|autorizado/i.test(text)) return "No se pudo validar tu acceso. Volvé a iniciar sesión o consultá con un administrador."
  if (/timeout|timed out|network|fetch|no respon|processing|en curso|concili|inciert/i.test(text)) {
    return "ARCA no confirmó el resultado. No vuelvas a emitir todavía. Actualizá el pedido y revisá el estado; si sigue pendiente, solicitá una conciliación a soporte."
  }
  if (/WSAA|WSFE|certif|private.key|token|config|credential|CUIT|punto de venta/i.test(text)) {
    return "La configuración de facturación necesita revisión. Pedí al responsable fiscal que verifique la habilitación y las credenciales antes de reintentar."
  }
  if (/documento|DNI|domicilio|receptor/i.test(text)) return "Revisá los datos fiscales del cliente en el pedido antes de reintentar la emisión."
  return "No se pudo completar la emisión. Actualizá el pedido y comprobá si el comprobante ya fue autorizado antes de reintentar. Si persiste, contactá a soporte."
}
