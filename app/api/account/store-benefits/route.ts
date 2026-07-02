import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ benefits: [] }, { status: 401 })
  }

  const { data, error } = await supabase
    .from("customer_store_benefits")
    .select("id, benefit_type, code, percent, created_at")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json(
      { error: "No se pudieron cargar los beneficios." },
      { status: 500 },
    )
  }

  return NextResponse.json({ benefits: data ?? [] })
}
