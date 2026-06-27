import { timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

const HANDOFF_MAX_AGE_MS = 2 * 60 * 60 * 1000

function tokensMatch(received: string, stored: unknown) {
  if (typeof stored !== "string") return false

  const receivedBuffer = Buffer.from(received)
  const storedBuffer = Buffer.from(stored)

  return (
    receivedBuffer.length === storedBuffer.length &&
    timingSafeEqual(receivedBuffer, storedBuffer)
  )
}

function isHandoffCurrent(createdAt: unknown) {
  if (typeof createdAt !== "string") return false

  const timestamp = Date.parse(createdAt)

  return (
    Number.isFinite(timestamp) &&
    Date.now() - timestamp >= 0 &&
    Date.now() - timestamp <= HANDOFF_MAX_AGE_MS
  )
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      userId?: string
      handoff?: string
    }
    const userId = body.userId?.trim() ?? ""
    const handoff = body.handoff?.trim() ?? ""

    if (!userId || !handoff) {
      return NextResponse.json({ confirmed: false }, { status: 400 })
    }

    const admin = createAdminClient()
    const {
      data: { user },
      error,
    } = await admin.auth.admin.getUserById(userId)

    if (
      error ||
      !user ||
      !tokensMatch(handoff, user.user_metadata?.confirmation_handoff) ||
      !isHandoffCurrent(
        user.user_metadata?.confirmation_handoff_created_at
      )
    ) {
      return NextResponse.json({ confirmed: false })
    }

    const emailConfirmed = Boolean(
      user.email_confirmed_at || user.confirmed_at
    )

    if (!emailConfirmed) {
      return NextResponse.json({ confirmed: false })
    }

    if (user.app_metadata?.account_activated !== true) {
      const { error: activationError } =
        await admin.auth.admin.updateUserById(user.id, {
          app_metadata: {
            ...user.app_metadata,
            account_activated: true,
            account_activated_at: new Date().toISOString(),
          },
          user_metadata: {
            ...user.user_metadata,
            pending_activation: false,
          },
        })

      if (activationError) {
        return NextResponse.json(
          {
            confirmed: false,
            error: "No pudimos completar la activación de la cuenta.",
          },
          { status: 500 }
        )
      }
    }

    if (!user.email) {
      return NextResponse.json(
        {
          confirmed: true,
          error: "La cuenta confirmada no tiene un email válido.",
        }
      )
    }

    const { data: linkData, error: linkError } =
      await admin.auth.admin.generateLink({
        type: "magiclink",
        email: user.email,
      })
    const tokenHash = linkData.properties?.hashed_token

    if (linkError || !tokenHash) {
      return NextResponse.json(
        {
          confirmed: true,
          error: "No pudimos iniciar la sesión en la pestaña original.",
        }
      )
    }

    return NextResponse.json({
      confirmed: true,
      tokenHash,
    })
  } catch {
    return NextResponse.json(
      { confirmed: false, error: "No pudimos consultar la confirmación." },
      { status: 500 }
    )
  }
}
