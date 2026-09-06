import { NextResponse } from "next/server"
import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { cleanClaimOperation } from "@/lib/orders/claim-server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET(request: Request) {
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  const admin = createAdminClient()
  // Mucho mayor al maxDuration de 300s: un upload no sigue escribiendo al limpiarse.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await admin.from("order_claim_operations").select("id").in("status", ["uploading", "failed"]).lt("expires_at", cutoff).order("expires_at").limit(100)
  if (error) return NextResponse.json({ error: "No se pudo consultar la limpieza." }, { status: 500 })
  let cleaned = 0
  for (const operation of data ?? []) {
    const { data: claimed, error: updateError } = await admin.from("order_claim_operations").update({ status: "failed" }).eq("id", operation.id).in("status", ["uploading", "failed"]).lt("expires_at", cutoff).select("id").maybeSingle()
    if (!updateError && claimed && await cleanClaimOperation(admin, operation.id)) cleaned++
  }
  return NextResponse.json({ inspected: data?.length ?? 0, cleaned })
}
