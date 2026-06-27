import { createClient } from "@supabase/supabase-js"
import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"

import {
  EMAIL_CONFIRMATION_CHANNEL,
  EMAIL_CONFIRMATION_STORAGE_KEY,
  type EmailConfirmationEvent,
} from "@/lib/auth/confirmation-events"
import { createAdminClient } from "@/lib/supabase/admin"

const CONFIRMATION_TYPES = new Set<EmailOtpType>([
  "signup",
  "email",
  "invite",
])

function getConfirmationVerificationTypes(type: EmailOtpType) {
  if (type === "email") {
    return ["signup", "email"] satisfies EmailOtpType[]
  }

  return [type]
}

function confirmationPage(
  success: boolean,
  confirmationEvent?: EmailConfirmationEvent
) {
  const title = success ? "Cuenta confirmada" : "No pudimos confirmar la cuenta"
  const message = success
    ? "La pestaña donde te registraste continuará automáticamente."
    : "Volvé a la pestaña de registro y solicitá un correo nuevo."
  const color = success ? "#34d399" : "#f87171"
  const serializedEvent = JSON.stringify(confirmationEvent ?? null)
    .replaceAll("<", "\\u003c")
  const serializedStorageKey = JSON.stringify(EMAIL_CONFIRMATION_STORAGE_KEY)
  const serializedChannel = JSON.stringify(EMAIL_CONFIRMATION_CHANNEL)

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} | BEYONIX</title>
    <style>
      body {
        align-items: center;
        background: #02060d;
        color: #fff;
        display: flex;
        font-family: Arial, sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
        text-align: center;
      }
      main { max-width: 420px; }
      h1 { color: ${color}; font-size: 24px; }
      p { color: rgba(255, 255, 255, 0.7); line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
    ${
      success
        ? `<script>
      try {
        const confirmationEvent = ${serializedEvent};
        localStorage.setItem(
          ${serializedStorageKey},
          JSON.stringify(confirmationEvent)
        );
        if ("BroadcastChannel" in window) {
          const channel = new BroadcastChannel(${serializedChannel});
          channel.postMessage(confirmationEvent);
          channel.close();
        }
        window.setTimeout(() => {
          window.opener?.focus();
          window.close();
        }, 250);
      } catch {}
    </script>`
        : ""
    }
  </body>
</html>`
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get("token_hash")?.trim() ?? ""
  const type = url.searchParams.get("type") as EmailOtpType | null

  if (!tokenHash || !type || !CONFIRMATION_TYPES.has(type)) {
    return new NextResponse(confirmationPage(false), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }

  const auth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  )

  type VerifyOtpResult = Awaited<ReturnType<typeof auth.auth.verifyOtp>>
  let verificationResult: VerifyOtpResult | null = null
  let verificationError: VerifyOtpResult["error"] | null = null

  for (const verificationType of getConfirmationVerificationTypes(type)) {
    const result = await auth.auth.verifyOtp({
      token_hash: tokenHash,
      type: verificationType,
    })

    if (!result.error && result.data.user) {
      verificationResult = result
      break
    }

    verificationError = result.error
  }

  if (!verificationResult?.data.user) {
    console.warn("AUTH_CONFIRM_VERIFY_FAILED", {
      type,
      message: verificationError?.message,
      status: verificationError?.status,
      code: verificationError?.code,
    })
    return new NextResponse(confirmationPage(false), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }

  const { user } = verificationResult.data
  const admin = createAdminClient()
  const { error: activationError } = await admin.auth.admin.updateUserById(
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

  const confirmationEvent: EmailConfirmationEvent = {
    userId: user.id,
    email: user.email?.trim().toLowerCase() ?? "",
    confirmedAt: Date.now(),
  }

  return new NextResponse(
    confirmationPage(!activationError, confirmationEvent),
    {
      status: activationError ? 500 : 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    }
  )
}
