import { NextResponse } from "next/server"

import { confirmPasswordReset } from "@/lib/auth/reset-password-confirm"
import { createAdminClient } from "@/lib/supabase/admin"

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? ""
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : ""

    const body = (await request.json().catch(() => null)) as {
      password?: unknown
    } | null

    const result = await confirmPasswordReset({
      admin: createAdminClient(),
      accessToken,
      passwordRaw: body?.password,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
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
