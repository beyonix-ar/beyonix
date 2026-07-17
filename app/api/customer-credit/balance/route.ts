import { NextResponse } from "next/server"

import { getCustomerCreditBalance } from "@/lib/customer-credit/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  try {
    const admin = createAdminClient()
    const balance = await getCustomerCreditBalance(admin, user.id)

    return NextResponse.json(
      {
        balance,
        currency: "ARS",
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos cargar tu saldo a favor.",
      },
      { status: 500 }
    )
  }
}
