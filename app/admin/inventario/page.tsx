import type { Metadata } from "next"

import { InventoryDiagnosticClient } from "./inventory-diagnostic-client"

export const metadata: Metadata = { title: "Diagnóstico de inventario" }

export default async function InventoryDiagnosticPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string }>
}) {
  const params = await searchParams
  const productId = Number(params.productId)

  return (
    <InventoryDiagnosticClient
      productId={Number.isSafeInteger(productId) && productId > 0 ? productId : null}
    />
  )
}
