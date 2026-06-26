"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  Check,
  CircleCheck,
  FileText,
  MessageCircle,
  Package,
  Paperclip,
  RefreshCcw,
  Send,
  Truck,
  Upload,
  X,
} from "lucide-react"

import {
  getClaimFileValidationError,
  getOrderClaimResolutionLabel,
} from "@/lib/order-claims"
import {
  getStoreCategorias,
  getStoreProductos,
} from "@/lib/supabase/queries/store"
import { beyonixHoverBorder } from "@/lib/utils"
import { ReplacementRequestSummary } from "@/components/claims/replacement-request-summary"
import type {
  OrderClaimResolution,
  OrderClaimType,
  SupabaseCategoria,
  SupabaseOrderClaim,
  SupabaseOrderClaimFile,
  SupabasePedido,
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

export type ClaimProblemId =
  | "danado"
  | "incorrecto"
  | "falla"
  | "devolucion"
  | "no_llego"
  | "otro"
  | "cambio_producto"
  | "cambio_color"
  | "cambio_cantidad"
  | "modificar_envio"
  | "cancelar_compra"
  | "otro_pre_despacho"
type ProblemId = ClaimProblemId
const CLAIM_DESCRIPTION_MIN_LENGTH = 10
const CLAIM_DESCRIPTION_MAX_LENGTH = 300

type ReplacementProduct = SupabaseProducto & {
  categorias?: Pick<SupabaseCategoria, "id" | "nombre" | "slug"> | null
  producto_variantes?: SupabaseProductoVariante[]
}

type ReplacementSelection = {
  key: string
  productId: number
  variantId: number | null
  quantity: number
}

type DropdownOption = {
  value: string
  label: string
}

type ProductDraftSelection = Record<number, { variantId: number | null; quantity: number }>

const PROBLEMS: Array<{
  id: ProblemId
  title: string
  description: string
  icon: typeof Package
  claimType: OrderClaimType
}> = [
  { id: "danado", title: "Llegó dañado", description: "El producto o paquete llegó roto", icon: Package, claimType: "transporte_48hs" },
  { id: "incorrecto", title: "Producto incorrecto", description: "Recibí algo diferente a lo comprado", icon: X, claimType: "transporte_48hs" },
  { id: "falla", title: "Producto con falla", description: "El producto dejó de funcionar", icon: AlertTriangle, claimType: "garantia_beyonix" },
  { id: "devolucion", title: "Quiero devolverlo", description: "Quiero solicitar una devolución", icon: RefreshCcw, claimType: "garantia_beyonix" },
  { id: "no_llego", title: "Nunca llegó el envío", description: "El pedido no llegó a destino", icon: Truck, claimType: "transporte_48hs" },
  { id: "otro", title: "Otro problema", description: "Necesito ayuda por otro motivo", icon: MessageCircle, claimType: "garantia_beyonix" },
]

const PRE_DISPATCH_PROBLEMS: Array<{
  id: ProblemId
  title: string
  description: string
  icon: typeof Package
  claimType: OrderClaimType
}> = [
  { id: "cambio_producto", title: "Me equivoqué de producto", description: "Quiero cambiar el producto elegido", icon: RefreshCcw, claimType: "garantia_beyonix" },
  { id: "cambio_color", title: "Me equivoqué de color", description: "Quiero cambiar la variante o color", icon: RefreshCcw, claimType: "garantia_beyonix" },
  { id: "cambio_cantidad", title: "Cambiar cantidad", description: "Quiero ajustar unidades del pedido", icon: RefreshCcw, claimType: "garantia_beyonix" },
  { id: "modificar_envio", title: "Cambiar dirección", description: "Necesito corregir dirección o datos de entrega", icon: Truck, claimType: "garantia_beyonix" },
  { id: "cancelar_compra", title: "Cancelar compra", description: "Solicitar cancelación antes del despacho", icon: X, claimType: "garantia_beyonix" },
  { id: "otro_pre_despacho", title: "Otro problema con mi pedido", description: "Necesito ayuda antes del despacho", icon: MessageCircle, claimType: "garantia_beyonix" },
]

const PROBLEM_LABELS: Record<string, string> = {
  danado: "Llegó dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  devolucion: "Solicitud de devolución",
  no_llego: "Nunca llegó el envío",
  otro: "Otro problema",
  cambio_producto: "Me equivoqué de producto",
  cambio_color: "Me equivoqué de color",
  cambio_cantidad: "Cambiar cantidad",
  modificar_envio: "Cambiar dirección",
  cancelar_compra: "Cancelar compra",
  otro_pre_despacho: "Otro problema con mi pedido",
}

function isOrderDispatched(order: SupabasePedido) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    ["enviado", "en_camino", "entregado"].includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function isPaidOrder(order: SupabasePedido) {
  const paymentStatus = (order.payment_status ?? "").toLowerCase()
  return ["confirmed", "confirmado"].includes(paymentStatus)
}

function isOrderInvoiced(order: SupabasePedido) {
  return order.invoice_status === "authorized" || Boolean(order.invoice_cae)
}

function getCustomerClaimMessageText(message: string) {
  const match = message.match(/^Producto afectado:\s*.+?(?:\r?\n){2}([\s\S]*)$/)
  return match?.[1]?.trim() || message
}

function getAffectedProductsFromDescription(description: string) {
  const match = description.match(/^Producto afectado:\s*(.+?)(?:\r?\n){2}/)
  return match?.[1]?.trim() || ""
}

function isInternalCustomerClaimMessage(message: string) {
  return (
    message.startsWith("El cliente acept") ||
    message.startsWith("El cliente rechaz")
  )
}

function getItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return item.producto_variantes?.imagenes?.[0]
    || item.productos?.imagen_principal
    || item.productos?.imagenes_producto?.[0]?.url
    || ""
}

function getItemVariant(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return item.producto_variantes?.nombre?.trim() || "Sin variante"
}

function getItemPrice(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return Number(item.precio ?? 0) * Number(item.cantidad ?? 1)
}

function getProductImage(product: ReplacementProduct) {
  return (
    product.imagen_principal ||
    product.imagenes_producto?.[0]?.url ||
    product.producto_variantes?.find((variant) => variant.imagenes?.[0])?.imagenes?.[0] ||
    ""
  )
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function statusInfo(status: SupabaseOrderClaim["status"]) {
  if (status === "recibido") return { label: "Reclamo recibido", dot: "bg-blue-400", style: "border-blue-300/25 bg-blue-400/10" }
  if (status === "falta_informacion") return { label: "Esperando tu respuesta", dot: "bg-orange-400", style: "border-orange-300/25 bg-orange-400/10" }
  if (status === "aprobado") return { label: "Solución ofrecida", dot: "bg-blue-300", style: "border-blue-300/25 bg-[#112A43]" }
  if (status === "reintegro_pendiente") return { label: "Reintegro pendiente", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/10" }
  if (status === "cambio_pendiente") return { label: "Cambio pendiente", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/10" }
  if (status === "cupon_pendiente") return { label: "Cupón pendiente", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/10" }
  if (status === "reemplazo_enviado") return { label: "Reemplazo enviado", dot: "bg-blue-300", style: "border-blue-300/25 bg-[#112A43]" }
  if (status === "cerrado") return { label: "Resuelto", dot: "bg-emerald-400", style: "border-emerald-300/25 bg-emerald-400/10" }
  if (status === "rechazado") return { label: "Rechazado", dot: "bg-red-400", style: "border-red-300/25 bg-red-400/10" }
  return { label: "En revisión", dot: "bg-amber-400", style: "border-amber-300/25 bg-amber-400/10" }
}

function FilePreview({ file }: { file: SupabaseOrderClaimFile }) {
  const isImage = file.mime_type.startsWith("image/")
  const isVideo = file.mime_type.startsWith("video/")
  if (isImage && file.signedUrl) {
    return <a href={file.signedUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-blue-300/15 bg-[#181818]"><img src={file.signedUrl} alt={file.file_name} className="h-24 w-full object-cover" /><span className="block truncate px-2.5 py-1.5 text-xs font-bold text-white">{file.file_name}</span></a>
  }
  if (isVideo && file.signedUrl) {
    return <div className="overflow-hidden rounded-lg border border-blue-300/15 bg-[#181818]"><video src={file.signedUrl} controls className="h-28 w-full bg-black object-contain" /><span className="block truncate px-2.5 py-1.5 text-xs font-bold text-white">{file.file_name}</span></div>
  }
  return <a href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-blue-300/15 bg-[#181818] px-2.5 py-2 text-xs font-bold text-white"><FileText className="size-4 text-blue-300" /><span className="truncate">{file.file_name}</span></a>
}

function EvidenceUploader({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="flex min-h-16 cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed border-blue-300/30 bg-[#181818] px-3 py-2 text-left transition hover:border-blue-300/60">
        <Upload className="size-5 shrink-0 text-blue-300" />
        <span><span className="block text-xs font-black text-white">Adjuntar fotos, videos o archivos</span><span className="mt-0.5 block text-[11px] text-white/65">Las fotos nos ayudan a resolver tu caso más rápido.</span></span>
        <input type="file" multiple disabled={disabled} accept="image/*,video/*,.pdf,.doc,.docx,.txt" className="sr-only" onChange={(event) => onChange([...files, ...Array.from(event.target.files ?? [])])} />
      </label>
      {files.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{files.map((file, index) => <span key={`${file.name}-${index}`} className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border border-white/10 bg-[#181818] px-2.5 py-1.5 text-xs font-bold text-white"><Paperclip className="size-3.5 shrink-0 text-blue-300" /><span className="truncate">{file.name}</span><button type="button" aria-label={`Quitar ${file.name}`} onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}><X className="size-3.5" /></button></span>)}</div>}
    </div>
  )
}

function appendFiles(formData: FormData, files: File[], role: string) {
  files.forEach((file) => {
    formData.append("files", file)
    formData.append("fileRoles", role)
  })
}

function BeyonixDropdown({
  value,
  options,
  onChange,
  className = "",
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value) ?? options[0]

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#101820] px-3 text-left text-xs font-bold text-white outline-none transition hover:border-blue-300/35 focus:border-blue-300/45"
      >
        <span className="truncate">{selected?.label ?? "Seleccionar"}</span>
        <ChevronDown className="size-3.5 shrink-0 text-blue-200" />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-30 max-h-56 w-full min-w-44 overflow-y-auto rounded-lg border border-blue-300/20 bg-[#101820] p-1 shadow-2xl shadow-black/40">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={`block w-full rounded-md px-2.5 py-2 text-left text-xs font-bold transition ${option.value === value ? "bg-[#112A43] text-white" : "text-white/75 hover:bg-white/7 hover:text-white"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function QuantityStepper({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  const current = Math.max(1, Math.min(99, value || 1))

  return (
    <div className="flex h-9 items-center rounded-lg border border-white/10 bg-[#181818]">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, current - 1))}
        className="flex h-full w-8 items-center justify-center rounded-l-lg text-sm font-black text-white/70 transition hover:bg-[#112A43] hover:text-white"
      >
        -
      </button>
      <span className="flex h-full min-w-8 items-center justify-center border-x border-white/10 px-2 text-xs font-black tabular-nums text-white">
        {current}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(99, current + 1))}
        className="flex h-full w-8 items-center justify-center rounded-r-lg text-sm font-black text-white/70 transition hover:bg-[#112A43] hover:text-white"
      >
        +
      </button>
    </div>
  )
}

function ReplacementSelectionPanel({
  products,
  categories,
  loading,
  loadError,
  search,
  category,
  selectedItems,
  draftSelections,
  originalItem,
  originalPrice,
  selectedTotal,
  difference,
  onSearchChange,
  onCategoryChange,
  onDraftVariantChange,
  onDraftQuantityChange,
  onProductToggle,
  onVariantChange,
  onQuantityChange,
  onRemoveProduct,
  onSubmit,
  submitting,
}: {
  products: ReplacementProduct[]
  categories: Array<Pick<SupabaseCategoria, "id" | "nombre" | "slug">>
  loading: boolean
  loadError: string
  search: string
  category: string
  selectedItems: ReplacementSelection[]
  draftSelections: ProductDraftSelection
  originalItem?: NonNullable<SupabasePedido["orden_items"]>[number]
  originalPrice: number
  selectedTotal: number
  difference: number
  onSearchChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onDraftVariantChange: (productId: number, value: number | null) => void
  onDraftQuantityChange: (productId: number, value: number) => void
  onProductToggle: (product: ReplacementProduct) => void
  onVariantChange: (itemKey: string, value: number | null) => void
  onQuantityChange: (itemKey: string, value: number) => void
  onRemoveProduct: (itemKey: string) => void
  onSubmit: () => void
  submitting: boolean
}) {
  const originalQuantity = Number(originalItem?.cantidad ?? 1)
  const originalUnitPrice = originalQuantity > 0 ? originalPrice / originalQuantity : originalPrice
  const resultTitle = difference > 0 ? "Diferencia a pagar" : difference < 0 ? "Saldo a favor" : "Sin diferencia"
  const resultValue = difference === 0 ? formatPrice(0) : formatPrice(Math.abs(difference))
  const resultTone =
    difference > 0
      ? "border-amber-300/25 bg-amber-400/10 text-amber-100"
      : difference < 0
        ? "border-[#77E6E2]/25 bg-[#77E6E2]/10 text-[#D7FFFD]"
        : "border-blue-300/20 bg-[#112A43]/25 text-blue-100"
  const categoryOptions = [
    { value: "all", label: "Todas" },
    ...categories.map((item) => ({ value: String(item.id), label: item.nombre })),
  ]
  const selectedProducts = selectedItems
    .map((item) => {
      const product = products.find((current) => current.id === item.productId)
      if (!product) return null
      const variant = product.producto_variantes?.find((current) => current.id === item.variantId) ?? null
      const unitPrice = Number(product.precio ?? 0)
      return { item, product, variant, unitPrice, subtotal: unitPrice * item.quantity }
    })
    .filter(Boolean) as Array<{ item: ReplacementSelection; product: ReplacementProduct; variant: SupabaseProductoVariante | null; unitPrice: number; subtotal: number }>

  return (
    <div className="mt-2.5 rounded-xl border border-white/10 bg-[#181818] p-3 shadow-[0_18px_45px_rgba(0,0,0,0.18)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-black text-white">Elegí el producto solicitado</p>
          <p className="mt-1 text-xs leading-5 text-white/60">Buscá por nombre o categoría y seleccioná una opción del listado.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Buscar por nombre" className="h-9 w-44 rounded-lg border border-white/10 bg-[#101820] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-blue-300/45" />
          <BeyonixDropdown value={category} options={categoryOptions} onChange={onCategoryChange} className="w-40" />
        </div>
      </div>

      {loading ? <p className="mt-3 text-xs text-white/60">Cargando productos...</p> : <div className="mt-3 grid gap-2 md:grid-cols-2">
        {loadError && <p className="rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200 md:col-span-2">{loadError}</p>}
        {products.slice(0, 8).map((product) => {
          const selected = selectedItems.some((item) => item.productId === product.id)
          const image = getProductImage(product)
          const variantStock = (product.producto_variantes ?? [])
            .filter((variant) => variant.activo !== false)
            .reduce((total, variant) => total + Number(variant.stock ?? 0), 0)
          const availableStock = Number(product.stock ?? 0) || variantStock
          const variantsLabel = (product.producto_variantes ?? [])
            .filter((variant) => variant.activo !== false && Number(variant.stock ?? 0) > 0)
            .slice(0, 3)
            .map((variant) => variant.nombre)
            .filter(Boolean)
            .join(", ")
          const variants = (product.producto_variantes ?? []).filter((variant) => variant.activo !== false && Number(variant.stock ?? 0) > 0)
          const draft = draftSelections[product.id] ?? { variantId: variants[0]?.id ?? null, quantity: 1 }
          const variantOptions = variants.map((variant) => ({ value: String(variant.id), label: variant.nombre }))
          return <div key={product.id} className={`rounded-xl border p-2.5 text-left transition ${selected ? "border-blue-300/55 bg-[#101820] shadow-[0_0_0_1px_rgba(30,111,174,0.18)]" : "border-white/10 bg-[#101820] hover:border-blue-300/35"}`}>
            <div className="flex min-h-20 gap-3">
              <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">{image ? <img src={image} alt={product.nombre} className="size-full object-contain" /> : <Package className="size-5 text-black/30" />}</span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm text-white">{product.nombre}</strong>
                <span className="mt-1 block text-10px font-bold uppercase tracking-wide text-blue-200">{product.categorias?.nombre ?? "Producto"}</span>
                {variantsLabel && <span className="mt-1 block truncate text-10px font-bold text-white/60">Variantes: {variantsLabel}</span>}
                <span className={`mt-1 block text-10px font-bold ${availableStock > 0 ? "text-[#77E6E2]" : "text-red-300"}`}>{availableStock > 0 ? "Disponible" : "Sin stock"}</span>
                <span className="mt-1 block text-xs font-black text-white">{formatPrice(Number(product.precio ?? 0))}</span>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/8 pt-2">
              {variantOptions.length > 1 && <BeyonixDropdown value={draft.variantId ? String(draft.variantId) : variantOptions[0]?.value ?? ""} options={variantOptions} onChange={(value) => onDraftVariantChange(product.id, value ? Number(value) : null)} className="w-40" />}
              <QuantityStepper value={draft.quantity} onChange={(value) => onDraftQuantityChange(product.id, value)} />
              <button type="button" onClick={() => onProductToggle(product)} className="h-9 rounded-lg border border-blue-300/25 bg-[#112A43]/35 px-3 text-10px font-black text-blue-100 transition hover:border-blue-300/55 hover:bg-[#112A43]/55">Agregar</button>
            </div>
          </div>
        })}
        {products.length === 0 && <p className="rounded-lg border border-white/10 bg-[#101820] px-3 py-2 text-xs text-white/60 md:col-span-2">No encontramos productos con esos filtros.</p>}
      </div>}

      {selectedProducts.length > 0 && <div className="mt-3 rounded-xl border border-blue-300/20 bg-[#112A43]/10 p-3">
        <p className="mb-2 text-10px font-black uppercase tracking-wide text-blue-200">Producto/s solicitado/s</p>
        <div className="space-y-2">
          {selectedProducts.map(({ item, product, variant, unitPrice, subtotal }) => {
            const variants = (product.producto_variantes ?? []).filter((current) => current.activo !== false && Number(current.stock ?? 0) > 0)
            const variantOptions = variants.map((current) => ({ value: String(current.id), label: current.nombre }))
            const image = getProductImage(product)
            return (
              <div key={item.key} className="grid gap-2 rounded-xl border border-blue-300/15 bg-[#101820] p-2 sm:grid-cols-[minmax(0,1fr)_10rem_6rem_auto] sm:items-center">
                <div className="flex min-w-0 gap-3">
                  <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">{image ? <img src={image} alt={product.nombre} className="size-full object-contain" /> : <Package className="size-4 text-black/30" />}</span>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black text-white">{product.nombre}</p>
                    <p className="mt-0.5 text-10px text-white/55">{variant?.nombre ?? "Sin variante"}</p>
                    <p className="mt-0.5 text-10px text-white/45">{formatPrice(unitPrice)} unitario · Subtotal {formatPrice(subtotal)}</p>
                  </div>
                </div>
                {variantOptions.length > 0 ? <BeyonixDropdown value={item.variantId ? String(item.variantId) : variantOptions[0]?.value ?? ""} options={variantOptions} onChange={(value) => onVariantChange(item.key, value ? Number(value) : null)} className="w-full" /> : <p className="rounded-lg border border-white/8 bg-[#181818] px-3 py-2 text-xs font-bold text-white/55">Sin variante</p>}
                <QuantityStepper value={item.quantity} onChange={(value) => onQuantityChange(item.key, value)} />
                <button type="button" onClick={() => onRemoveProduct(item.key)} className="h-9 rounded-lg border border-red-300/25 bg-red-500/10 px-3 text-10px font-black text-red-100 transition hover:border-red-300/45">Quitar</button>
              </div>
            )
          })}
        </div>
        <div className="mt-3 rounded-xl border border-white/10 bg-[#101820] p-3 text-xs">
          <p className="text-10px font-black uppercase tracking-wide text-white/55">Resumen del cambio</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="rounded-lg border border-white/10 bg-[#15191F] p-2.5">
              <p className="text-10px font-black uppercase tracking-wide text-white/45">Producto actual</p>
              <p className="mt-1 font-black text-white">{originalItem?.productos?.nombre ?? "Producto original"}</p>
              <p className="text-white/60">Variante original: {originalItem ? getItemVariant(originalItem) : "Sin variante"}</p>
              <p className="text-white/60">Cantidad original: {originalQuantity}</p>
              <p className="mt-1 text-white/45">Precio unitario: {formatPrice(originalUnitPrice)}</p>
              <p className="font-bold text-white/80">Subtotal actual: {formatPrice(originalPrice)}</p>
            </div>
            <div className="hidden text-center text-lg font-black text-blue-200 sm:block">↓</div>
            <div className="rounded-lg border border-blue-300/20 bg-[#112A43]/20 p-2.5">
              <p className="text-10px font-black uppercase tracking-wide text-blue-200">Producto/s solicitado/s</p>
              <div className="mt-1 space-y-1">
                {selectedProducts.map(({ item, product, variant, unitPrice, subtotal }) => (
                  <div key={item.key}>
                    <p className="font-black text-white">{product.nombre}</p>
                    <p className="text-white/60">{variant?.nombre ?? "Sin variante"} · Cantidad {item.quantity}</p>
                    <p className="text-white/45">{formatPrice(unitPrice)} unitario · Subtotal {formatPrice(subtotal)}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 font-black text-white">Subtotal solicitado: {formatPrice(selectedTotal)}</p>
            </div>
          </div>
          <div className={`mt-2 rounded-lg border px-2.5 py-2 ${resultTone}`}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-10px font-black uppercase tracking-wide opacity-75">Resultado</p>
              <p className="text-sm font-black">{resultTitle}: {resultValue}</p>
            </div>
            <p className="mt-1 text-10px leading-4 opacity-75">El costo de envío puede variar según el producto elegido. BEYONIX revisará la solicitud antes de aprobarla.</p>
            {difference < 0 && <p className="mt-1 text-10px leading-4">El saldo a favor podrá aplicarse como nota de crédito, cupón o crédito interno para una próxima compra.</p>}
          </div>
        </div>
        <button type="button" disabled={submitting} onClick={onSubmit} className="mt-3 h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45">Enviar solicitud</button>
      </div>}
    </div>
  )
}

export function CustomerClaimExperience({ order, initialProblem }: { order: SupabasePedido; initialProblem?: ClaimProblemId }) {
  const orderItems = order.orden_items ?? []
  const dispatched = isOrderDispatched(order)
  const invoiced = isOrderInvoiced(order)
  const canModifyOrder = !dispatched && !invoiced
  const preDispatchClaim = canModifyOrder
  const availableProblems = canModifyOrder ? PRE_DISPATCH_PROBLEMS : PROBLEMS
  const changeAlreadyUsed = preDispatchClaim && order.order_change_used === true
  const wholeOrderDisabled = orderItems.length === 1
  const defaultAffectedItems = orderItems.length === 1 ? [String(orderItems[0].id)] : []
  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(order.order_claims ?? [])
  const [step, setStep] = useState<1 | 2 | 3>(initialProblem ? 2 : 1)
  const [affectedItems, setAffectedItems] = useState<string[]>(defaultAffectedItems)
  const [problem, setProblem] = useState<ProblemId | null>(initialProblem ?? null)
  const [description, setDescription] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<File[]>([])
  const [differenceProofFiles, setDifferenceProofFiles] = useState<File[]>([])
  const [selectedResolution, setSelectedResolution] = useState<OrderClaimResolution | null>(null)
  const [refundAccountHolder, setRefundAccountHolder] = useState("")
  const [refundAccountIdentifier, setRefundAccountIdentifier] = useState("")
  const [refundBank, setRefundBank] = useState("")
  const [refundAmountConfirmed, setRefundAmountConfirmed] = useState("")
  const [replacementProducts, setReplacementProducts] = useState<ReplacementProduct[]>([])
  const [replacementCategories, setReplacementCategories] = useState<Array<Pick<SupabaseCategoria, "id" | "nombre" | "slug">>>([])
  const [replacementSearch, setReplacementSearch] = useState("")
  const [replacementCategory, setReplacementCategory] = useState("all")
  const [selectedReplacementItems, setSelectedReplacementItems] = useState<ReplacementSelection[]>([])
  const [replacementDraftSelections, setReplacementDraftSelections] = useState<ProductDraftSelection>({})
  const [replacementLoading, setReplacementLoading] = useState(false)
  const [replacementLoaded, setReplacementLoaded] = useState(false)
  const [replacementLoadError, setReplacementLoadError] = useState("")
  const [justCreated, setJustCreated] = useState<SupabaseOrderClaim | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const replacementLoadRequestId = useRef(0)
  const replacementCategoryInitialized = useRef(false)

  const loadClaims = useCallback(async () => {
    const response = await fetch(`/api/orders/${order.id}/claims`)
    const data = (await response.json()) as { claims?: SupabaseOrderClaim[] }
    if (response.ok) setClaims(data.claims ?? [])
  }, [order.id])

  useEffect(() => {
    void loadClaims()
    const intervalId = window.setInterval(() => void loadClaims(), 5000)
    window.addEventListener("focus", loadClaims)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener("focus", loadClaims)
    }
  }, [loadClaims])

  useEffect(() => {
    if (!initialProblem || claims.length > 0) return
    setProblem(initialProblem)
    setStep(defaultAffectedItems.length > 0 ? 2 : 1)
  }, [claims.length, defaultAffectedItems.length, initialProblem])

  const activeClaim = claims.find((claim) =>
    [
      "recibido",
      "en_revision",
      "falta_informacion",
      "aprobado",
      "reintegro_pendiente",
      "cambio_pendiente",
      "cupon_pendiente",
      "reemplazo_enviado",
    ].includes(claim.status),
  )
  const claim = activeClaim ?? claims[0]
  const messageCount = claim?.order_claim_messages?.length ?? 0
  const needsReplacementSelection =
    claim?.status === "cambio_pendiente" &&
    ["cambio_producto", "cambio_color"].includes(claim.failure_type ?? "") &&
    !claim.replacement_requested_product_id
  const selectingReplacementBeforeCreate = !claim && step === 3 && problem === "cambio_producto"

  useEffect(() => {
    if (!(needsReplacementSelection || selectingReplacementBeforeCreate) || replacementLoaded) return

    let active = true
    const requestId = replacementLoadRequestId.current + 1
    replacementLoadRequestId.current = requestId
    setReplacementLoading(true)
    setReplacementLoadError("")

    Promise.all([getStoreProductos(), getStoreCategorias()])
      .then(([productsData, categoriesData]) => {
        if (!active || replacementLoadRequestId.current !== requestId) return
        const availableProducts = productsData.filter((product) => {
          const variantStock = (product.producto_variantes ?? [])
            .filter((variant) => variant.activo !== false)
            .reduce(
            (total, variant) => total + Number(variant.stock ?? 0),
            0,
          )

          return Number(product.stock ?? 0) > 0 || variantStock > 0
        })

        setReplacementProducts(availableProducts)
        setReplacementDraftSelections((current) => {
          const next = { ...current }
          availableProducts.forEach((product) => {
            if (next[product.id]) return
            const firstAvailableVariant = product.producto_variantes?.find(
              (variant) => variant.activo !== false && Number(variant.stock ?? 0) > 0,
            )
            next[product.id] = { variantId: firstAvailableVariant?.id ?? null, quantity: 1 }
          })
          return next
        })
        setReplacementCategories(categoriesData)
        if (!replacementCategoryInitialized.current) {
          const selectedAffectedItemId = affectedItems.find((item) => item !== "order")
          const affectedOrderItem =
            orderItems.find((item) => String(item.id) === selectedAffectedItemId) ??
            orderItems[0]
          const originalCategoryId = affectedOrderItem?.productos?.categoria_id
          const matchingCategory = categoriesData.find((category) => Number(category.id) === Number(originalCategoryId))

          if (matchingCategory) {
            setReplacementCategory(String(matchingCategory.id))
          }

          replacementCategoryInitialized.current = true
        }
        setReplacementLoaded(true)
      })
      .catch((loadError: unknown) => {
        if (!active || replacementLoadRequestId.current !== requestId) return
        setReplacementLoaded(true)
        setReplacementLoadError(loadError instanceof Error ? loadError.message : "No se pudieron cargar los productos.")
      })
      .finally(() => {
        if (active && replacementLoadRequestId.current === requestId) setReplacementLoading(false)
      })

    return () => {
      active = false
    }
  }, [needsReplacementSelection, selectingReplacementBeforeCreate, replacementLoaded, affectedItems, orderItems])

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (!chat) return

    chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  const validateFiles = (selectedFiles: File[]) => selectedFiles.map((file) => getClaimFileValidationError(file)).find(Boolean) ?? ""
  const trimmedDescription = description.trim()
  const descriptionOptional = PRE_DISPATCH_PROBLEMS.some((item) => item.id === problem)
  const hasAffectedSelection = affectedItems.length > 0
  const wholeOrderSelected = affectedItems.includes("order")

  const toggleAffectedProduct = (value: string) => {
    setAffectedItems((current) => {
      const withoutWholeOrder = current.filter((item) => item !== "order")
      return withoutWholeOrder.includes(value)
        ? withoutWholeOrder.filter((item) => item !== value)
        : [...withoutWholeOrder, value]
    })
    setError("")
  }

  const selectWholeOrder = () => {
    if (wholeOrderDisabled) return
    setAffectedItems(["order"])
    setError("")
  }

  const createClaim = async () => {
    if (changeAlreadyUsed) return setError("Ya usaste la corrección disponible para este pedido.")
    if (!hasAffectedSelection) return setError("Elegí el producto afectado o seleccioná todo el pedido.")
    if (!problem) return setError("Elegí el problema que mejor describe lo ocurrido.")
    if (problem === "cambio_producto" && selectedReplacementItems.length === 0) return setError("Elegí al menos un producto solicitado.")
    if (!descriptionOptional && trimmedDescription.length < CLAIM_DESCRIPTION_MIN_LENGTH) return setError("Contanos un poco más para poder ayudarte.")
    const fileError = validateFiles(files)
    if (fileError) return setError(fileError)
    setLoading(true); setError("")
    try {
      const selected = availableProblems.find((item) => item.id === problem)!
      const affectedLabel = wholeOrderSelected
        ? "Todo el pedido"
        : affectedItems
            .map((affectedItem) => {
              const selectedOrderItem = orderItems.find((item) => String(item.id) === affectedItem)
              if (!selectedOrderItem) return null
              return `${selectedOrderItem.productos?.nombre ?? "Producto"} · ${getItemVariant(selectedOrderItem)}`
            })
            .filter(Boolean)
            .join(", ")
      const formData = new FormData()
      formData.set("claimType", selected.claimType)
      formData.set("problemType", problem)
      formData.set("affectedItemIds", affectedItems.filter((item) => item !== "order").join(","))
      formData.set("description", `Producto afectado: ${affectedLabel}\n\n${trimmedDescription}`)
      if (problem === "cambio_producto" && selectedReplacementItems.length > 0) {
        formData.set("replacementItems", JSON.stringify(selectedReplacementPayload))
        const firstReplacement = selectedReplacementPayload[0]
        formData.set("replacementProductId", String(firstReplacement.productId))
        if (firstReplacement.variantId) {
          formData.set("replacementVariantId", String(firstReplacement.variantId))
        }
        formData.set("replacementQuantity", String(firstReplacement.quantity))
        if (originalReplacementItem?.id) {
          formData.set("replacementOriginalOrderItemId", String(originalReplacementItem.id))
        }
        formData.set("replacementOriginalProduct", originalReplacementItem?.productos?.nombre || "Producto original")
        formData.set("replacementOriginalVariant", originalReplacementItem ? getItemVariant(originalReplacementItem) : "")
        formData.set("replacementOriginalPrice", String(originalReplacementPrice))
        formData.set("replacementChangeReason", PROBLEM_LABELS[problem] ?? "Cambio de producto")
      }
      appendFiles(formData, files, "evidencia_inicial")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo enviar el reclamo.")
      setClaims((current) => [data.claim!, ...current])
      if (PRE_DISPATCH_PROBLEMS.some((item) => item.id === problem)) {
        setJustCreated(null)
      } else {
        setJustCreated(data.claim)
      }
    } catch { setError("No se pudo enviar el reclamo. Intentá nuevamente.") } finally { setLoading(false) }
  }

  const sendReply = async (currentClaim: SupabaseOrderClaim) => {
    const currentMessages = [...(currentClaim.order_claim_messages ?? [])].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    if (currentMessages[currentMessages.length - 1]?.author_role === "cliente") return setError("Mensaje enviado. Esperá la respuesta de BEYONIX para continuar.")
    if (reply.trim().length < 5 && replyFiles.length === 0) return setError("Escribí un mensaje o adjuntá un archivo.")
    const fileError = validateFiles(replyFiles)
    if (fileError) return setError(fileError)
    setLoading(true); setError("")
    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id)); formData.set("message", reply.trim())
      appendFiles(formData, replyFiles, "evidencia_adicional")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo enviar el mensaje.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item)); setReply(""); setReplyFiles([])
    } catch { setError("No se pudo enviar el mensaje.") } finally { setLoading(false) }
  }

  const acceptResolution = async (currentClaim: SupabaseOrderClaim) => {
    if (!selectedResolution) return setError("Elegí una de las soluciones ofrecidas.")
    setLoading(true); setError("")
    try {
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: currentClaim.id, selectedResolution, decision: "accept" }) })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo aceptar la solución.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
    } catch { setError("No se pudo aceptar la solución.") } finally { setLoading(false) }
  }

  const rejectResolution = async (currentClaim: SupabaseOrderClaim) => {
    setLoading(true); setError("")
    try {
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: currentClaim.id, decision: "reject" }) })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo rechazar la solución.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item)); setSelectedResolution(null)
    } catch { setError("No se pudo rechazar la solución.") } finally { setLoading(false) }
  }

  const submitRefundDetails = async (currentClaim: SupabaseOrderClaim) => {
    const holder = refundAccountHolder.trim()
    const identifier = refundAccountIdentifier.trim()
    const bank = refundBank.trim()
    const amount = refundAmountConfirmed.trim()
    if (!holder || !identifier || !bank || !amount) {
      setError("Completá todos los datos para avanzar con el reintegro.")
      return
    }

    setLoading(true); setError("")
    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id))
      formData.set("refundAccountHolder", holder)
      formData.set("refundAccountIdentifier", identifier)
      formData.set("refundBank", bank)
      formData.set("refundAmountConfirmed", amount)
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudieron enviar los datos del reintegro.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
      setRefundAccountHolder("")
      setRefundAccountIdentifier("")
      setRefundBank("")
      setRefundAmountConfirmed("")
    } catch {
      setError("No se pudieron enviar los datos del reintegro.")
    } finally {
      setLoading(false)
    }
  }

  const submitDifferenceProof = async (currentClaim: SupabaseOrderClaim) => {
    if (differenceProofFiles.length === 0) {
      setError("Subí el comprobante de la diferencia para enviarlo.")
      return
    }

    const fileError = validateFiles(differenceProofFiles)
    if (fileError) return setError(fileError)

    setLoading(true); setError("")
    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id))
      appendFiles(formData, differenceProofFiles.slice(0, 1), "comprobante_diferencia")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo enviar el comprobante.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
      setDifferenceProofFiles([])
    } catch {
      setError("No se pudo enviar el comprobante.")
    } finally {
      setLoading(false)
    }
  }

  const originalReplacementItem =
    orderItems.find((item) => Number(item.id) === Number(claim?.replacement_original_order_item_id)) ??
    orderItems.find((item) => String(item.id) === affectedItems.find((affectedItem) => affectedItem !== "order")) ??
    orderItems[0]
  const originalReplacementPrice = originalReplacementItem ? getItemPrice(originalReplacementItem) : 0
  const selectedReplacementDetails = selectedReplacementItems
    .map((item) => {
      const product = replacementProducts.find((current) => current.id === item.productId)
      if (!product) return null
      const variant = product.producto_variantes?.find((current) => current.id === item.variantId) ?? null
      const unitPrice = Number(product.precio ?? 0)
      return { item, product, variant, unitPrice, subtotal: unitPrice * item.quantity }
    })
    .filter(Boolean) as Array<{ item: ReplacementSelection; product: ReplacementProduct; variant: SupabaseProductoVariante | null; unitPrice: number; subtotal: number }>
  const selectedReplacementPrice = selectedReplacementDetails.reduce((total, entry) => total + entry.subtotal, 0)
  const replacementDifference = selectedReplacementPrice - originalReplacementPrice
  const selectedReplacementPayload = selectedReplacementDetails.map(({ item, product, variant, unitPrice, subtotal }) => ({
    productId: product.id,
    productName: product.nombre,
    variantId: variant?.id ?? null,
    variantName: variant?.nombre ?? null,
    quantity: item.quantity,
    unitPrice,
    subtotal,
    image: getProductImage(product),
  }))
  const normalizedReplacementSearch = replacementSearch.trim().toLowerCase()
  const filteredReplacementProducts = replacementProducts.filter((product) => {
    if ((claim?.failure_type === "cambio_color" || problem === "cambio_color") && originalReplacementItem?.producto_id && Number(product.id) !== Number(originalReplacementItem.producto_id)) {
      return false
    }

    const matchesSearch =
      !normalizedReplacementSearch ||
      product.nombre.toLowerCase().includes(normalizedReplacementSearch)
    const matchesCategory =
      replacementCategory === "all" ||
      String(product.categoria_id ?? product.categorias?.id ?? "") === replacementCategory

    return matchesSearch && matchesCategory
  })
  const filteredReplacementProductIds = filteredReplacementProducts.map((product) => product.id).join(",")

  useEffect(() => {
    setSelectedReplacementItems((current) =>
      current.filter((item) => filteredReplacementProducts.some((product) => product.id === item.productId)),
    )
  }, [filteredReplacementProductIds])

  const getReplacementKey = (productId: number, variantId: number | null) => `${productId}:${variantId ?? "base"}`

  const toggleReplacementProduct = (product: ReplacementProduct) => {
    setSelectedReplacementItems((current) => {
      const fallbackVariant = product.producto_variantes?.find(
        (variant) => variant.activo !== false && Number(variant.stock ?? 0) > 0,
      )
      const draft = replacementDraftSelections[product.id]
      const variantId = draft?.variantId ?? fallbackVariant?.id ?? null
      const quantity = Math.max(1, Math.min(99, draft?.quantity ?? 1))
      const key = getReplacementKey(product.id, variantId)
      const existing = current.find((item) => item.key === key)

      if (existing) {
        return current.map((item) =>
          item.key === key ? { ...item, quantity: Math.min(99, item.quantity + quantity) } : item,
        )
      }

      return [...current, { key, productId: product.id, variantId, quantity }]
    })
  }

  const updateDraftVariant = (productId: number, variantId: number | null) => {
    setReplacementDraftSelections((current) => ({
      ...current,
      [productId]: { variantId, quantity: current[productId]?.quantity ?? 1 },
    }))
  }

  const updateDraftQuantity = (productId: number, quantity: number) => {
    setReplacementDraftSelections((current) => ({
      ...current,
      [productId]: { variantId: current[productId]?.variantId ?? null, quantity },
    }))
  }

  const updateReplacementVariant = (itemKey: string, variantId: number | null) => {
    setSelectedReplacementItems((current) => {
      const source = current.find((item) => item.key === itemKey)
      if (!source) return current

      const nextKey = getReplacementKey(source.productId, variantId)
      const duplicate = current.find((item) => item.key === nextKey && item.key !== itemKey)

      if (duplicate) {
        return current
          .filter((item) => item.key !== itemKey)
          .map((item) =>
            item.key === nextKey
              ? { ...item, quantity: Math.min(99, item.quantity + source.quantity) }
              : item,
          )
      }

      return current.map((item) =>
        item.key === itemKey ? { ...item, key: nextKey, variantId } : item,
      )
    })
  }

  const updateReplacementQuantity = (itemKey: string, quantity: number) => {
    setSelectedReplacementItems((current) =>
      current.map((item) => item.key === itemKey ? { ...item, quantity } : item),
    )
  }

  const submitReplacementSelection = async (currentClaim: SupabaseOrderClaim) => {
    if (selectedReplacementPayload.length === 0) {
      setError("Elegí al menos un producto solicitado.")
      return
    }

    setLoading(true); setError("")
    try {
      const firstReplacement = selectedReplacementPayload[0]
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id))
      formData.set("replacementItems", JSON.stringify(selectedReplacementPayload))
      formData.set("replacementProductId", String(firstReplacement.productId))
      if (firstReplacement.variantId) {
        formData.set("replacementVariantId", String(firstReplacement.variantId))
      }
      formData.set("replacementQuantity", String(firstReplacement.quantity))
      if (originalReplacementItem?.id) {
        formData.set("replacementOriginalOrderItemId", String(originalReplacementItem.id))
      }
      formData.set("replacementOriginalProduct", getAffectedProductsFromDescription(currentClaim.description) || originalReplacementItem?.productos?.nombre || "Producto original")
      formData.set("replacementOriginalVariant", originalReplacementItem ? getItemVariant(originalReplacementItem) : "")
      formData.set("replacementOriginalPrice", String(originalReplacementPrice))
      formData.set("replacementChangeReason", PROBLEM_LABELS[currentClaim.failure_type ?? ""] ?? "Cambio de producto")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo guardar el producto de reemplazo.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
    } catch {
      setError("No se pudo guardar el producto de reemplazo.")
    } finally {
      setLoading(false)
    }
  }

  if (justCreated) {
    const info = statusInfo(justCreated.status)
    return <section className="mb-2 rounded-xl border border-blue-300/15 bg-black p-3"><div className="mx-auto w-full rounded-xl border border-blue-300/15 bg-[#141414] p-4 text-center"><CircleCheck className="mx-auto size-9 text-emerald-400" /><p className="mt-3 text-[11px] font-black uppercase tracking-[0.18em] text-blue-300">Reclamo creado</p><h3 className="mt-1 text-xl font-black text-white">Recibimos tu reclamo</h3><div className={`mx-auto mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black text-white ${info.style}`}><span className={`size-2 rounded-full ${info.dot}`} />{info.label}</div><p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-5 text-white/80">Nuestro equipo revisará la información y te responderá por este medio.</p><div className="mt-4 grid gap-2 text-left sm:grid-cols-3">{[["Fecha", formatDate(justCreated.created_at)], ["Pedido", `#BX-${1000 + order.id}`], ["Motivo", PROBLEM_LABELS[justCreated.failure_type ?? ""] ?? "Solicitud de ayuda"]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#181818] px-3 py-2"><p className="text-[11px] font-bold text-white/60">{label}</p><p className="mt-0.5 text-xs font-black text-white">{value}</p></div>)}</div><button type="button" onClick={() => setJustCreated(null)} className={`mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white ${beyonixHoverBorder}`}>Ver reclamo</button></div></section>
  }

  if (claim) {
    const info = statusInfo(claim.status)
    const orderModification = PRE_DISPATCH_PROBLEMS.some((item) => item.id === claim.failure_type)
    const messages = [...(claim.order_claim_messages ?? [])].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    const customerTurnLocked = messages[messages.length - 1]?.author_role === "cliente"
    const offered = claim.offered_resolutions ?? []
    const offerMessage = offered.length > 0
      ? [...messages].reverse().find((message) => message.author_role !== "cliente" && message.message.startsWith("Te ofrecemos:"))
      : undefined
    const visibleMessages = (offerMessage
      ? messages.filter((message) => message.id !== offerMessage.id)
      : messages
    ).filter((message) => !isInternalCustomerClaimMessage(message.message))
    const open = !["cerrado", "rechazado"].includes(claim.status)
    const claimFiles = claim.order_claim_files ?? []
    const refundProof = claimFiles.find((file) => file.file_role === "comprobante_devolucion")
    const differenceProof = [...claimFiles].reverse().find((file) => file.file_role === "comprobante_diferencia")
    const evidenceFiles = claimFiles.filter((file) => !["comprobante_devolucion", "comprobante_diferencia"].includes(file.file_role))
    const evidenceSent = evidenceFiles.length > 0
    const canUploadEvidence = !evidenceSent || claim.status === "falta_informacion"
    const solutionPending = claim.status === "aprobado" && offered.length > 0 && !claim.customer_selected_resolution
    const isRefundResolution =
      claim.customer_selected_resolution === "reintegro_total" ||
      claim.customer_selected_resolution === "reintegro_parcial"
    const refundPending = claim.status === "reintegro_pendiente" && isRefundResolution
    const refundDetailsSubmitted = Boolean(claim.refund_details_submitted_at)
    const replacementPending = claim.status === "cambio_pendiente"
    const replacementSent = claim.status === "reemplazo_enviado"
    const couponPending = claim.status === "cupon_pendiente"
    const replacementClaimDifference = Number(claim.replacement_price_difference ?? 0)
    const replacementDifferenceActions = replacementClaimDifference > 0 ? (
      <div className="rounded-lg border border-amber-300/18 bg-amber-400/5 p-2">
        {differenceProof?.signedUrl && (
          <a href={differenceProof.signedUrl} target="_blank" rel="noreferrer" className="mb-2 flex items-center gap-2 rounded-lg border border-amber-300/20 bg-black/20 px-2 py-1.5 text-10px font-bold text-amber-100 hover:border-amber-300/40">
            <FileText className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Ver comprobante cargado</span>
          </a>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-blue-300/20 bg-[#112A43]/45 px-2.5 text-10px font-black text-white transition hover:border-blue-300/45">
            <Upload className="size-3.5" />
            {differenceProof ? "Cambiar comprobante" : "Subir comprobante"}
            <input type="file" disabled={loading} accept="image/*,application/pdf" className="sr-only" onChange={(event) => setDifferenceProofFiles(Array.from(event.target.files ?? []).slice(0, 1))} />
          </label>
          {differenceProofFiles[0] && <span className="inline-flex max-w-48 items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-10px font-bold text-white"><Paperclip className="size-3 shrink-0 text-blue-300" /><span className="truncate">{differenceProofFiles[0].name}</span><button type="button" aria-label="Quitar comprobante" onClick={() => setDifferenceProofFiles([])}><X className="size-3" /></button></span>}
          <button type="button" disabled={loading || differenceProofFiles.length === 0} onClick={() => void submitDifferenceProof(claim)} className="h-8 rounded-lg border border-amber-300/25 bg-amber-400/10 px-2.5 text-10px font-black text-amber-100 transition hover:border-amber-300/45 disabled:cursor-not-allowed disabled:opacity-45">Enviar</button>
        </div>
      </div>
    ) : null
    return <section className="mb-1 rounded-xl border border-blue-300/15 bg-[#141414] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2"><div><h3 className="text-base font-black text-white">{orderModification ? "Modificación del pedido" : "Seguimiento del reclamo"}</h3><p className="mt-0.5 text-[11px] text-white/55">Pedido #BX-{1000 + order.id} · {PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Solicitud de ayuda"}</p></div><span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black text-white ${info.style}`}><span className={`size-2 rounded-full ${info.dot}`} />Estado: {info.label}</span></div>
      {claim.rejection_reason && <div className="mt-2.5 rounded-xl border border-red-300/20 bg-red-500/8 p-3"><p className="text-xs font-black text-white">Motivo del rechazo</p><p className="mt-1 text-xs leading-5 text-white/85">{claim.rejection_reason}</p></div>}
      <div className="mt-2.5 overflow-hidden rounded-lg border border-white/7 bg-[#181818]"><div className="border-b border-white/8 px-3 py-2"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-300">Conversación</p></div><div ref={chatRef} className="min-h-72 max-h-[32rem] space-y-2 overflow-y-auto p-2.5">{visibleMessages.map((message) => { const customer = message.author_role === "cliente"; return <div key={message.id} className={`flex ${customer ? "justify-end" : "justify-start"}`}><div className={`max-w-[82%] rounded-lg px-2.5 py-1.5 ${customer ? "bg-[#112A43]" : "bg-black/45"}`}><p className="text-[10px] font-black text-blue-200">{customer ? "Vos" : "BEYONIX"}</p><p className="whitespace-pre-wrap text-xs leading-4 text-white">{getCustomerClaimMessageText(message.message)}</p><p className="mt-0.5 text-[9px] text-white/45">{formatDate(message.created_at)}</p></div></div> })}{claim.replacement_requested_product && <div className="flex justify-end"><div className="w-full max-w-[88%]"><ReplacementRequestSummary claim={claim} actions={replacementDifferenceActions} /></div></div>}{visibleMessages.length === 0 && offered.length === 0 && !claim.replacement_requested_product && <p className="text-xs text-white/65">La conversación todavía no tiene mensajes.</p>}{offered.length > 0 && <div className="flex justify-start"><div className="w-full max-w-[88%] rounded-xl border border-blue-300/18 bg-[#101820] p-2.5"><p className="text-xs font-black text-white"><span className="text-blue-300">BEYONIX</span> te ofreció una solución</p><p className="mt-1.5 text-[10px] font-bold uppercase tracking-wide text-white/50">Opciones</p><div className="mt-1.5 flex flex-wrap gap-1.5">{offered.map((resolution) => { const selected = selectedResolution === resolution || claim.customer_selected_resolution === resolution; return <button type="button" key={resolution} disabled={Boolean(claim.customer_selected_resolution)} onClick={() => setSelectedResolution(resolution)} className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-left text-[11px] font-black text-white transition-colors ${claim.customer_selected_resolution === resolution ? "border-emerald-400/55 bg-emerald-700/65" : selected ? "border-blue-300/45 bg-[#162D43]" : "border-white/10 bg-[#121A22] hover:border-blue-300/35"} disabled:cursor-default disabled:opacity-100`}><Check className={`size-3 ${selected ? "text-emerald-300" : "text-blue-300"}`} />{getOrderClaimResolutionLabel(resolution)}</button> })}</div>{claim.customer_selected_resolution ? <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-400/35 bg-emerald-700/35 px-2.5 py-2"><span className="size-2 rounded-full bg-emerald-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-emerald-100">Elegiste</span><strong className="text-xs text-white">{getOrderClaimResolutionLabel(claim.customer_selected_resolution)}</strong></div> : <div className="mt-2.5 flex flex-wrap gap-2"><button type="button" disabled={loading || !selectedResolution} onClick={() => void acceptResolution(claim)} className="h-9 rounded-lg bg-[#16A34A] px-3.5 text-xs font-black text-white shadow-[0_0_10px_rgba(22,163,74,0.24)] transition-colors hover:bg-[#15803D] disabled:cursor-not-allowed disabled:opacity-45">Aceptar solución</button><button type="button" disabled={loading} onClick={() => void rejectResolution(claim)} className="h-9 rounded-lg border border-red-400/45 bg-red-950/55 px-3.5 text-xs font-black text-white transition-colors hover:border-red-300 hover:bg-red-900/65 disabled:cursor-not-allowed disabled:opacity-45">Rechazar solución</button></div>}<p className="mt-1.5 text-[9px] text-white/40">{offerMessage ? formatDate(offerMessage.created_at) : formatDate(claim.updated_at)}</p></div></div>}</div></div>
      {evidenceSent && <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#181818] px-3 py-2"><span className="text-xs font-bold text-emerald-300"><Check className="mr-1 inline size-3.5" />Evidencia enviada</span><details><summary className="cursor-pointer text-xs font-black text-blue-300">Ver archivos enviados ({evidenceFiles.length})</summary><div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{evidenceFiles.map((file) => <FilePreview key={file.id} file={file} />)}</div></details></div>}
      {replacementPending && <p className="mt-2.5 rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2 text-xs font-bold text-[#D7FFFD]">BEYONIX está preparando el cambio de producto. Te avisaremos cuando el reemplazo sea despachado.</p>}
      {replacementSent && <div className="mt-2.5 rounded-lg border border-blue-300/20 bg-[#112A43]/35 px-3 py-2 text-xs font-bold text-blue-100"><p>El reemplazo fue enviado.</p>{claim.replacement_tracking && <p className="mt-1 text-white/75">Seguimiento: {claim.replacement_tracking}</p>}</div>}
      {couponPending && <p className="mt-2.5 rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2 text-xs font-bold text-[#D7FFFD]">BEYONIX está generando tu cupón. Vas a poder verlo y copiarlo cuando quede disponible.</p>}
      {claim.coupon_code && <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2"><span className="text-xs font-bold text-[#D7FFFD]">Cupón disponible:</span><code className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs font-black text-white">{claim.coupon_code}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(claim.coupon_code ?? "")} className="h-7 rounded-md border border-blue-300/20 px-2 text-10px font-black text-blue-200 hover:border-blue-300/45">Copiar</button></div>}
      {needsReplacementSelection && <ReplacementSelectionPanel products={filteredReplacementProducts} categories={replacementCategories} loading={replacementLoading} loadError={replacementLoadError} search={replacementSearch} category={replacementCategory} selectedItems={selectedReplacementItems} draftSelections={replacementDraftSelections} originalItem={originalReplacementItem} originalPrice={originalReplacementPrice} selectedTotal={selectedReplacementPrice} difference={replacementDifference} onSearchChange={setReplacementSearch} onCategoryChange={setReplacementCategory} onDraftVariantChange={updateDraftVariant} onDraftQuantityChange={updateDraftQuantity} onProductToggle={toggleReplacementProduct} onVariantChange={updateReplacementVariant} onQuantityChange={updateReplacementQuantity} onRemoveProduct={(itemKey) => setSelectedReplacementItems((current) => current.filter((item) => item.key !== itemKey))} onSubmit={() => void submitReplacementSelection(claim)} submitting={loading} />}
      {open ? <div className="mt-2.5">{solutionPending ? <p className="rounded-lg border border-blue-300/20 bg-[#112A43]/40 px-3 py-2 text-xs font-bold text-blue-100">BEYONIX te ofreció una solución. Aceptala o rechazala para continuar.</p> : refundPending && !refundDetailsSubmitted ? <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 p-3"><p className="text-xs font-black text-white">Completá los datos para recibir el reintegro.</p><p className="mt-1 text-xs leading-5 text-white/65">Mientras esperamos estos datos, la conversación queda pausada.</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={refundAccountHolder} onChange={(event) => setRefundAccountHolder(event.target.value)} placeholder="Titular de la cuenta" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /><input value={refundAccountIdentifier} onChange={(event) => setRefundAccountIdentifier(event.target.value)} placeholder="Alias o CBU/CVU" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /><input value={refundBank} onChange={(event) => setRefundBank(event.target.value)} placeholder="Banco / billetera" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /><input value={refundAmountConfirmed} onChange={(event) => setRefundAmountConfirmed(event.target.value)} placeholder="Importe a recibir" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /></div><button type="button" disabled={loading} onClick={() => void submitRefundDetails(claim)} className="mt-3 h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45">Enviar datos</button></div> : refundPending ? <p className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2 text-xs font-bold text-[#D7FFFD]">Datos recibidos. BEYONIX realizará el reintegro.</p> : <><textarea ref={replyRef} value={reply} disabled={customerTurnLocked || loading || needsReplacementSelection} onChange={(event) => setReply(event.target.value)} rows={2} placeholder={needsReplacementSelection ? "Elegí el producto de reemplazo para continuar" : "Escribí tu mensaje"} className="w-full resize-none rounded-lg border border-blue-300/15 bg-[#181818] px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/50 focus:border-blue-300/50 disabled:cursor-not-allowed disabled:opacity-45" />{customerTurnLocked && <p className="mt-2 rounded-lg border border-orange-300/15 bg-orange-400/8 px-3 py-2 text-xs font-bold text-orange-100">Mensaje enviado. Esperá la respuesta de BEYONIX para continuar.</p>}<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">{canUploadEvidence ? <div className={`min-w-0 flex-1 ${customerTurnLocked ? "opacity-45" : ""}`}><EvidenceUploader files={replyFiles} onChange={setReplyFiles} disabled={loading || customerTurnLocked || needsReplacementSelection} /></div> : <p className="text-[11px] text-white/55">Podrás adjuntar nueva evidencia si BEYONIX solicita más información.</p>}<button type="button" disabled={loading || customerTurnLocked || needsReplacementSelection} onClick={() => void sendReply(claim)} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45"><Send className="size-3.5" />{loading ? "Enviando..." : "Enviar"}</button></div></>}{error && <p className="mt-2 text-xs font-bold text-red-300">{error}</p>}</div> : <div className="mt-2.5 space-y-2"><p className="rounded-lg border border-emerald-300/15 bg-emerald-500/8 px-3 py-2 text-xs font-bold text-emerald-100">{claim.customer_selected_resolution ? `Caso finalizado. Solución aceptada: ${getOrderClaimResolutionLabel(claim.customer_selected_resolution)}.` : "Caso finalizado. Podés consultar la conversación cuando quieras."}</p>{refundProof?.signedUrl && <a href={refundProof.signedUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#77E6E2]/25 bg-[#77E6E2]/5 px-3 text-xs font-black text-white hover:border-[#77E6E2]/45"><FileText className="size-3.5 text-[#77E6E2]" />Ver comprobante de devolución</a>}</div>}
    </section>
  }

  const selected = availableProblems.find((item) => item.id === problem)
  return <section className="customer-claim-experience rounded-2xl border border-blue-300/15 bg-[#0D1117] p-3 sm:p-5">
    <div className="mb-5 grid grid-cols-3 gap-2">
      {["Producto", "Motivo", "Detalle"].map((label, index) => { const number = index + 1; const active = step >= number; return <div key={label} className="flex items-center gap-2"><span className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-black ${active ? "border-blue-300/45 bg-[#112A43] text-white" : "border-white/10 bg-[#1B2028] text-white/45"}`}>{number}</span><span className={`hidden text-xs font-black sm:block ${active ? "text-white" : "text-white/40"}`}>{label}</span>{number < 3 && <span className="ml-auto h-px flex-1 bg-white/10" />}</div> })}
    </div>

    {step === 1 && <div>
      <p className="text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 1 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">{canModifyOrder ? "¿Qué producto querés modificar?" : "¿Con qué producto tuviste el problema?"}</h3>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {orderItems.map((item) => { const value = String(item.id); const image = getItemImage(item); const selectedItem = affectedItems.includes(value); const name = item.productos?.nombre ?? `Producto #${item.producto_id}`; return <button key={item.id} type="button" onClick={() => toggleAffectedProduct(value)} className={`flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition ${selectedItem ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white">{image ? <img src={image} alt={name} className="size-full object-contain" /> : <Package className="size-5 text-black/30" />}</span><span className="min-w-0"><strong className="block text-sm text-white">{name}</strong><span className="mt-1 block text-xs text-white/62">{getItemVariant(item)} · Cantidad: {item.cantidad}</span><span className="mt-1 block text-xs font-black text-white">{formatPrice(Number(item.precio))}</span></span></button> })}
        <button type="button" disabled={wholeOrderDisabled} onClick={selectWholeOrder} className={`flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition ${wholeOrderDisabled ? "cursor-not-allowed border-white/7 bg-[#141820] opacity-45" : wholeOrderSelected ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-[#1B2028]"><Truck className="size-6 text-blue-300" /></span><span><strong className="block text-sm text-white">Todo el pedido</strong><span className="mt-1 block text-xs leading-4 text-white/62">{wholeOrderDisabled ? "Disponible cuando hay más de un producto o problemas generales del envío." : "Para problemas con el envío, un envío incorrecto o el paquete completo."}</span></span></button>
      </div>
      <button type="button" disabled={!hasAffectedSelection} onClick={() => { if (hasAffectedSelection) setStep(2) }} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Continuar</button>
    </div>}

    {step === 2 && <div>
      <button type="button" onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 text-xs font-bold text-white/65"><ArrowLeft className="size-3.5" />Cambiar producto</button>
      <p className="mt-3 text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 2 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">{canModifyOrder ? "¿Qué querés modificar?" : "¿Qué ocurrió?"}</h3>
      {changeAlreadyUsed && <p className="mt-3 rounded-lg border border-orange-300/20 bg-orange-400/8 px-3 py-2 text-xs font-bold text-orange-100">Ya usaste la corrección disponible para este pedido.</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{availableProblems.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" disabled={changeAlreadyUsed} onClick={() => { setProblem(item.id); if (item.id === "no_llego" && !wholeOrderDisabled) setAffectedItems(["order"]); setError("") }} className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${problem === item.id ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.3)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="rounded-lg bg-[#1B2028] p-2"><Icon className="size-5 text-blue-300" /></span><span><strong className="block text-sm text-white">{item.title}</strong><span className="mt-0.5 block text-xs leading-4 text-white/60">{item.description}</span></span></button>})}</div>
      <button type="button" disabled={!problem || changeAlreadyUsed} onClick={() => { if (problem && !changeAlreadyUsed) setStep(3) }} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Continuar</button>
    </div>}

    {step === 3 && <div>
      <button type="button" onClick={() => setStep(2)} className="inline-flex items-center gap-1.5 text-xs font-bold text-white/65"><ArrowLeft className="size-3.5" />Cambiar motivo</button>
      <p className="mt-3 text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 3 de 3</p>
      {problem === "cambio_producto" ? <>
        <h3 className="mt-1 text-xl font-black text-white">Elegí el producto nuevo</h3>
        <p className="mt-1 text-xs leading-5 text-white/65">Seleccioná el producto, variante y cantidad. La solicitud se crea recién cuando enviás este resumen.</p>
        <ReplacementSelectionPanel products={filteredReplacementProducts} categories={replacementCategories} loading={replacementLoading} loadError={replacementLoadError} search={replacementSearch} category={replacementCategory} selectedItems={selectedReplacementItems} draftSelections={replacementDraftSelections} originalItem={originalReplacementItem} originalPrice={originalReplacementPrice} selectedTotal={selectedReplacementPrice} difference={replacementDifference} onSearchChange={setReplacementSearch} onCategoryChange={setReplacementCategory} onDraftVariantChange={updateDraftVariant} onDraftQuantityChange={updateDraftQuantity} onProductToggle={toggleReplacementProduct} onVariantChange={updateReplacementVariant} onQuantityChange={updateReplacementQuantity} onRemoveProduct={(itemKey) => setSelectedReplacementItems((current) => current.filter((item) => item.key !== itemKey))} onSubmit={() => void createClaim()} submitting={loading} />
        {error && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
      </> : <>
      <h3 className="mt-1 text-xl font-black text-white">{canModifyOrder ? "Detalle de la modificación" : "Contanos qué pasó"}</h3>
      <p className="mt-1 text-xs leading-5 text-white/65">{descriptionOptional ? "Podés agregar un comentario si querés. Si corresponde, después vas a elegir el producto o variante nueva." : `Contanos brevemente qué ocurrió para poder ayudarte más rápido. Motivo: ${selected?.title}.`}</p>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} minLength={descriptionOptional ? undefined : CLAIM_DESCRIPTION_MIN_LENGTH} maxLength={CLAIM_DESCRIPTION_MAX_LENGTH} placeholder={descriptionOptional ? "Podés contarnos el motivo si querés…" : "Describí el problema con el mayor detalle posible…"} className="mt-3 w-full resize-none rounded-xl border border-blue-300/15 bg-[#141820] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/40 focus:border-blue-300/50" />
      <p className="mt-1 text-right text-10px text-white/40">{description.length}/{CLAIM_DESCRIPTION_MAX_LENGTH}</p>
      <div className="mt-2"><EvidenceUploader files={files} onChange={setFiles} disabled={loading} /></div>
      {error && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
      <button type="button" disabled={loading || (!descriptionOptional && trimmedDescription.length < CLAIM_DESCRIPTION_MIN_LENGTH)} onClick={() => void createClaim()} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{loading ? "Enviando..." : "Enviar solicitud"}</button>
      </>}
    </div>}
  </section>
}
