import "server-only"

import { isRecoverySessionToken } from "./recovery-session.ts"
import {
  getInvalidRecoveryLinkMessage,
  getPasswordUpdateErrorMessage,
} from "./password-update-messages.ts"
import { validatePassword } from "../validation/account-fields.ts"
import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export type ConfirmPasswordResetResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export interface ConfirmPasswordResetInput {
  admin: AdminClient
  accessToken: string
  passwordRaw: unknown
}

/**
 * Autoritativo: único lugar que efectivamente cambia la contraseña por
 * recuperación (ver app/api/auth/reset-password/confirm/route.ts, que sólo
 * hace el parseo del request y llama acá). Exige un access_token cuya
 * sesión se haya establecido específicamente vía el flujo de recuperación
 * (`amr` con method "recovery", ver recovery-session.ts) -- nunca alcanza
 * con cualquier sesión autenticada válida.
 */
export async function confirmPasswordReset({
  admin,
  accessToken,
  passwordRaw,
}: ConfirmPasswordResetInput): Promise<ConfirmPasswordResetResult> {
  if (!accessToken) {
    return { ok: false, status: 401, error: getInvalidRecoveryLinkMessage() }
  }

  if (!isRecoverySessionToken(accessToken)) {
    return { ok: false, status: 403, error: getInvalidRecoveryLinkMessage() }
  }

  const {
    data: { user },
    error: userError,
  } = await admin.auth.getUser(accessToken)

  if (userError || !user) {
    return { ok: false, status: 401, error: getInvalidRecoveryLinkMessage() }
  }

  const password = typeof passwordRaw === "string" ? passwordRaw : ""

  // Repite server-side la MISMA política que el cliente
  // (lib/validation/account-fields.ts): Supabase Auth por sí solo no
  // conoce los requisitos de mayúscula/minúscula/número de BEYONIX.
  const passwordError = validatePassword(password)
  if (passwordError) {
    return { ok: false, status: 400, error: passwordError }
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    user.id,
    { password },
  )

  if (updateError) {
    return {
      ok: false,
      status: 400,
      error: getPasswordUpdateErrorMessage(updateError.message),
    }
  }

  // Mejor esfuerzo: cierra cualquier OTRA sesión activa del usuario tras un
  // cambio de contraseña por recuperación. No aborta la respuesta si falla
  // -- la contraseña ya quedó cambiada, que es la operación crítica.
  try {
    await admin.auth.admin.signOut(accessToken, "others")
  } catch (signOutError) {
    console.error("RESET_PASSWORD_SIGN_OUT_OTHERS_ERROR", signOutError)
  }

  return { ok: true }
}
