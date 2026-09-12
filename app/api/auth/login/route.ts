import { NextResponse } from "next/server"

import { signInWithIdentifier } from "@/lib/auth/login"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Login con email O username, resuelto enteramente server-side (ver
 * lib/auth/login.ts). El cliente nunca recibe el email resuelto a partir de
 * un username ni puede distinguir "no existe" de "contraseña incorrecta" --
 * sólo el access_token/refresh_token final cuando la autenticación es
 * exitosa, para que context/auth-context.tsx los aplique con
 * supabase.auth.setSession().
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      identifier?: unknown
      password?: unknown
    } | null

    const result = await signInWithIdentifier({
      admin: createAdminClient(),
      identifierRaw: body?.identifier,
      passwordRaw: body?.password,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ ok: true, session: result.session })
  } catch (error) {
    console.error("LOGIN_ROUTE_ERROR", error)
    return NextResponse.json(
      { error: "No se pudo iniciar sesión. Intentá nuevamente." },
      { status: 500 },
    )
  }
}
