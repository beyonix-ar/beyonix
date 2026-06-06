import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const tokenHash = String(body.tokenHash ?? "")

    if (!tokenHash) {
      return NextResponse.json(
        { error: "El enlace de confirmación no es válido." },
        { status: 400 }
      )
    }

    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "email",
    })

    if (error) {
      return NextResponse.json(
        {
          error:
            "El enlace de confirmación venció o ya fue utilizado. Solicitá un correo nuevo.",
        },
        { status: 400 }
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
