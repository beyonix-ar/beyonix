import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { ORDER_CLAIM_BUCKET } from "@/lib/order-claims"

function stripClaimBucket(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path.slice(ORDER_CLAIM_BUCKET.length + 1)
    : path
}

async function attachSignedUrls(admin: any, claim: any) {
  return {
    ...claim,
    order_claim_files: await Promise.all(
      (claim.order_claim_files ?? []).map(async (file: any) => {
        const { data } = await admin.storage
          .from(ORDER_CLAIM_BUCKET)
          .createSignedUrl(stripClaimBucket(file.file_path), 300)

        return {
          ...file,
          signedUrl: data?.signedUrl ?? null,
        }
      }),
    ),
  }
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

  const claims = await Promise.all(
    (data ?? []).map((claim) => attachSignedUrls(auth.admin, claim)),
  )

  return NextResponse.json({ claims })
}
