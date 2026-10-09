"use client"

import { useState } from "react"
import Link from "next/link"
import { Barcode, ListPlus } from "lucide-react"

import { AdminButton, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import { buildLabelTargets, type LabelCatalogProduct } from "@/lib/labels/catalog"
import { labelQueueStore, labelSettingsStore } from "@/lib/labels/local-store"
import { addToQueue, createQueueItem, parseCopies, queueLabelCount } from "@/lib/labels/queue"
import type { SupabaseProductoVariante } from "@/lib/supabase/types"

export interface LabelQueueProductRef {
  id: number
  name: string
  price?: number | null
  randomSale?: boolean
}

// "Agregar a impresión" desde Productos: no imprime; suma la variante a la
// cola del módulo Etiquetas (Admin → Etiquetas), que la revalida al abrirse.
export function AddToLabelQueueDialog({ product, variant, onClose }: {
  product: LabelQueueProductRef
  variant: SupabaseProductoVariante | null
  onClose: () => void
}) {
  const [copies, setCopies] = useState("1")
  const [added, setAdded] = useState<string | null>(null)
  const [error, setError] = useState("")
  if (!variant) return null

  const catalogProduct: LabelCatalogProduct = {
    id: product.id,
    name: product.name,
    active: true,
    sku: null,
    barcode: null,
    price: product.price != null && product.price > 0 ? product.price : null,
    randomSale: product.randomSale === true,
    variants: [{
      id: variant.id,
      name: variant.nombre,
      active: variant.activo,
      stock: variant.stock,
      sku: variant.sku?.trim() || null,
      colorHex: variant.color_hex,
      colorHexSecondary: variant.color_hex_secundario ?? null,
      barcode: variant.codigo_barra?.trim() || null,
    }],
    aliases: [],
  }
  const target = buildLabelTargets(catalogProduct).targets[0]
  const option = target?.options[0]
  const maxCopies = labelSettingsStore.get().maxCopiesPerItem
  const copyCount = parseCopies(copies, maxCopies)
  const name = [product.name, target?.variantLabel].filter(Boolean).join(" · ")

  function add() {
    const item = target && option && copyCount ? createQueueItem(target, option.code, copyCount) : null
    if (!item) { setError(`Elegí una cantidad entre 1 y ${maxCopies}.`); return }
    const result = addToQueue(labelQueueStore.get(), item, maxCopies)
    if (result.rejected) { setError("La cola de impresión está llena. Imprimila o vaciala antes de seguir."); return }
    labelQueueStore.set(result.queue)
    setAdded(`${result.merged ? "Sumado" : "Agregado"} ×${copyCount}${result.clamped ? ` (tope de ${maxCopies})` : ""}. La cola tiene ${queueLabelCount(result.queue)} etiquetas.`)
  }

  return (
    <AdminModal
      open
      compact
      title="Agregar a impresión"
      description={option ? `${name} · ${option.code}` : name}
      onClose={onClose}
      footer={added ? (
        <div className="flex flex-wrap justify-end gap-2">
          <AdminButton onClick={onClose}>Seguir editando</AdminButton>
          <Link href={ADMIN_ROUTES.etiquetas} className="admin-ds-button admin-ds-button-primary inline-flex min-h-10 items-center justify-center gap-2 px-4 py-2 text-sm font-black">
            <Barcode className="size-4" />Ir a Etiquetas
          </Link>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <AdminButton onClick={onClose}>Cancelar</AdminButton>
          <AdminPrimaryButton icon={<ListPlus className="size-4" />} disabled={!option || !copyCount} onClick={add}>Agregar a la cola</AdminPrimaryButton>
        </div>
      )}
    >
      {added ? (
        <p role="status" className="text-sm font-bold text-white">{added}</p>
      ) : option ? (
        <div className="space-y-2">
          <p className="text-xs text-white/60">Se suma a la cola de Etiquetas para imprimir junto con otros productos. No se imprime ahora.</p>
          <p className="mb-1 text-xs font-black text-white">Cantidad de etiquetas</p>
          <AdminTextInput title="Cantidad de etiquetas" placeholder="1" inputMode="numeric" value={copies} onChange={(value) => { setCopies(value.replace(/\D/g, "").slice(0, 3)); setError("") }} />
          {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
        </div>
      ) : (
        <p className="text-sm text-white/70">Esta variante no tiene código de barra ni SKU para imprimir.</p>
      )}
    </AdminModal>
  )
}
