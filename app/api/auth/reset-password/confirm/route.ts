import { NextResponse } from "next/server"

import { isRecoverySessionToken } from "@/lib/auth/recovery-session"
import { getPasswordUpdateErrorMessage, getInvalidRecoveryLinkMessage } from "@/lib/auth/password-update-messages"
import { validatePassword } from "@/lib/validation/account-fields"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Confirma un cambio de contraseña por recuperación. Autoritativo: es el
 * ÚNICO lugar que efectivamente cambia la contraseña (antes lo hacía el
 * cliente llamando directo a `supabase.auth.updateUser`, sin repetir acá los
 * requisitos de composición -- Supabase Auth por sí solo no los conoce).
 *
 * Exige que el access token pertenezca específicamente a una sesión de
 * RECUPERACIÓN (claim `amr` con method "recovery", ver
 * lib/auth/recovery-session.ts) -- nunca alcanza con "cualquier sesión
 * autenticada válida". Así, visitar /reset-password sin haber pasado por un
 * enlace de recuperación real nunca permite cambiar la contraseña, ni
 * siquiera con una sesión normal ya iniciada.
 */
export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? ""
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : ""

    if (!accessToken) {
      return NextResponse.json(
        { error: getInvalidRecoveryLinkMessage() },
        { status: 401 },
      )
    }

    if (!isRecoverySessionToken(accessToken)) {
      return NextResponse.json(
        { error: getInvalidRecoveryLinkMessage() },
        { status: 403 },
      )
    }

    const admin = createAdminClient()
    const {
      data: { user },
      error: userError,
    } = await admin.auth.getUser(accessToken)

    if (userError || !user) {
      return NextResponse.json(
        { error: getInvalidRecoveryLinkMessage() },
        { status: 401 },
      )
    }

    const body = (await request.json().catch(() => null)) as {
      password?: unknown
    } | null
    const password = typeof body?.password === "string" ? body.password : ""

    // Repite server-side EXACTAMENTE la misma política que el cliente
    // (lib/validation/account-fields.ts): Supabase Auth por sí solo no
    // conoce los requisitos de mayúscula/minúscula/número de BEYONIX.
    const passwordError = validatePassword(password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 })
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(
      user.id,
      { password },
    )

    if (updateError) {
      return NextResponse.json(
        { error: getPasswordUpdateErrorMessage(updateError.message) },
        { status: 400 },
      )
    }

    // Mejor esfuerzo: cierra cualquier OTRA sesión activa del usuario (otro
    // dispositivo, otro navegador) tras un cambio de contraseña por
    // recuperación. No aborta la respuesta si falla -- la contraseña ya
    // quedó cambiada, que es la operación crítica.
    try {
      await admin.auth.admin.signOut(accessToken, "others")
    } catch (signOutError) {
      console.error("RESET_PASSWORD_SIGN_OUT_OTHERS_ERROR", signOutError)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("RESET_PASSWORD_CONFIRM_ERROR", error)
    return NextResponse.json(
      { error: "No se pudo actualizar la contraseña. Intentá nuevamente." },
      { status: 500 },
    )
  }
}
