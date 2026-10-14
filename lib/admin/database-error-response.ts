/**
 * Respuesta 500 de una ruta Admin cuando falla la base: el detalle técnico
 * (SQL, nombres de tablas, PostgREST) queda en el log del servidor y el
 * usuario recibe un mensaje entendible.
 */
export function databaseErrorResponse(
  error: { message?: string | null; code?: string | null } | null | undefined,
  userMessage: string,
  context = "ADMIN_DATABASE_ERROR",
) {
  console.error(context, { message: error?.message ?? null, code: error?.code ?? null })
  return Response.json({ error: userMessage }, { status: 500 })
}
