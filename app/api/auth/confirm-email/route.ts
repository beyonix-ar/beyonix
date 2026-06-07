import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? ""
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : ""

    if (!accessToken) {
      return NextResponse.json(
        { error: "No pudimos validar la sesión de confirmación." },
        { status: 401 }
      )
    }

    const admin = createAdminClient()
    const {
      data: { user },
      error: userError,
    } = await admin.auth.getUser(accessToken)

    if (userError || !user) {
      return NextResponse.json(
        { error: "El enlace de confirmación no es válido o venció." },
        { status: 401 }
      )
    }

    if (!user.email_confirmed_at && !user.confirmed_at) {
      return NextResponse.json(
        { error: "Primero tenés que validar el email desde el enlace recibido." },
        { status: 400 }
      )
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(
      user.id,
      {
        app_metadata: {
          ...user.app_metadata,
          account_activated: true,
          account_activated_at: new Date().toISOString(),
        },
        user_metadata: {
          ...user.user_metadata,
          pending_activation: false,
        },
      }
    )

    if (updateError) {
      return NextResponse.json(
        { error: "No pudimos activar tu cuenta. Intentá nuevamente." },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json(
      { error: "No pudimos confirmar tu cuenta. Intentá nuevamente." },
      { status: 500 }
    )
  }
}
