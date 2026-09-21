export class AdminRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "AdminRequestError"
    this.status = status
  }
}

export function describeAdminLoadError(error: unknown, object = "los datos") {
  if (error instanceof AdminRequestError) {
    if (error.status === 404) return "No encontramos este pedido. Puede haber sido eliminado o el enlace no es válido."
    if (error.status === 401) return "Tu sesión venció. Volvé a iniciar sesión para continuar."
    if (error.status === 403) return "No tenés permisos para ver esta información. Consultá con un administrador."
  }
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return `La consulta de ${object} demoró demasiado. Reintentá la carga.`
  }
  return `No se pudieron cargar ${object}. Revisá la conexión y reintentá.`
}
