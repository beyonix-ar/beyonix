import { getPasswordUpdateErrorMessage } from "./password-update-messages.ts"

export interface PasswordUpdateAuthClient {
  updateUser: (attrs: {
    password: string
  }) => Promise<{ error: { message: string } | null }>
  signOut: () => Promise<{ error: { message: string } | null }>
}

export type PasswordUpdateResult =
  | { status: "success" }
  | { status: "error"; message: string }

export interface PasswordUpdateSubmitter {
  /**
   * Llama a `updateUser({password})` sobre la sesión de recovery activa.
   * Éxito -> cierra la sesión (`signOut`) y resuelve "success". Error ->
   * NUNCA cierra la sesión (el usuario puede reintentar con otra
   * contraseña) y resuelve "error" con un mensaje seguro (nunca el error
   * crudo de Supabase, nunca la contraseña).
   *
   * Mientras una llamada está en curso, invocaciones adicionales devuelven
   * la MISMA promesa en curso (un doble submit/doble click nunca dispara un
   * segundo `updateUser`). Una vez que la llamada termina (éxito o error)
   * el gate se libera, así que un reintento LEGÍTIMO después de un error
   * real sí puede volver a llamar a `updateUser`.
   */
  submit: (password: string) => Promise<PasswordUpdateResult>
}

export function createPasswordUpdateSubmitter(
  auth: PasswordUpdateAuthClient,
): PasswordUpdateSubmitter {
  let inFlight: Promise<PasswordUpdateResult> | null = null

  const submit = (password: string): Promise<PasswordUpdateResult> => {
    if (inFlight) return inFlight

    const run = (async (): Promise<PasswordUpdateResult> => {
      try {
        const { error } = await auth.updateUser({ password })

        if (error) {
          return {
            status: "error",
            message: getPasswordUpdateErrorMessage(error.message),
          }
        }

        // Best-effort: la contraseña ya cambió (lo crítico), un fallo acá
        // (red, lo que sea) nunca debe mostrarse como si el cambio hubiera
        // fallado.
        try {
          await auth.signOut()
        } catch {
          // Ignorado a propósito -- ver comentario arriba.
        }

        return { status: "success" }
      } catch {
        // Excepción inesperada (ej. red caída en updateUser): mismo mensaje
        // genérico que un error de Supabase, nunca el detalle crudo.
        return {
          status: "error",
          message: "No se pudo actualizar la contraseña. Intentá nuevamente.",
        }
      } finally {
        inFlight = null
      }
    })()

    inFlight = run
    return run
  }

  return { submit }
}
