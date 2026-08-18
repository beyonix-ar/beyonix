import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { ORDER_CLAIM_BUCKET } from "@/lib/order-claims"

function stripClaimBucket(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path.slice(ORDER_CLAIM_BUCKET.length + 1)
    : path
}

// Firma todos los archivos de todos los reclamos de este pedido en una sola
// llamada a Storage en vez de una por archivo (evita el N+1 anterior).
async function attachSignedUrls(admin: any, claims: any[]) {
  const entries = claims.flatMap((claim) =>
    (claim.order_claim_files ?? []).map((file: any) => ({
      claimId: claim.id,
      file,
      path: stripClaimBucket(file.file_path),
    })),
  )
  const signedUrlByPath = new Map<string, string | null>()
  if (entries.length) {
    const { data: signedUrls } = await admin.storage
      .from(ORDER_CLAIM_BUCKET)
      .createSignedUrls(
        entries.map((entry) => entry.path),
        300,
      )
    for (const signed of signedUrls ?? []) {
      if (signed.path) signedUrlByPath.set(signed.path, signed.signedUrl ?? null)
    }
  }

  const filesByClaimId = new Map<number, any[]>()
  for (const entry of entries) {
    const current = filesByClaimId.get(entry.claimId) ?? []
    current.push({ ...entry.file, signedUrl: signedUrlByPath.get(entry.path) ?? null })
    filesByClaimId.set(entry.claimId, current)
  }

  return claims.map((claim) => ({
    ...claim,
    order_claim_files: filesByClaimId.get(claim.id) ?? [],
  }))
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json(
      { error: error.message || "No se pudieron cargar los mensajes." },
      { status: 500 },
    )
  }

  const claims = await attachSignedUrls(auth.admin, data ?? [])

  return NextResponse.json({ claims })
}
