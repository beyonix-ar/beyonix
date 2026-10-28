"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { getOrCreateIdempotencyAttempt, type IdempotencyAttempt } from "@/lib/business/idempotency-attempt"
import {
  EXTERNAL_SALE_CHANNEL_LABELS,
  EXTERNAL_SALE_CHANNELS,
  EXTERNAL_SALE_PAYMENT_LABELS,
  EXTERNAL_SALE_PAYMENT_METHODS,
  EXTERNAL_SALE_STOCK_EFFECT_LABELS,
  argentinaToday,
  parseExternalSaleAmount,
  type ExternalSaleActiveStatus,
  type ExternalSaleChannel,
  type ExternalSalePaymentMethod,
  type ExternalSaleStockEffect,
} from "@/lib/business/external-sales"
import {
  createExternalSale,
  getExternalSalesCatalog,
  updateExternalSale,
  type ExternalSaleCatalogProduct,
  type ExternalSaleFields,
  type ExternalSaleListItem,
} from "@/lib/supabase/queries/external-sales"
import { AdminDatePicker } from "../../components/admin-date-picker"
import {
  AdminFormField,
  AdminInfoBlock,
  AdminModal,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSelect,
  AdminTextInput,
  AdminTextarea,
} from "../../components/admin-controls"

interface FormState {
  saleDate: string
  customerName: string
  channel: ExternalSaleChannel
  catalogKey: string
  sku: string
  productName: string
  quantity: string
  finalPrice: string
  shippingAmount: string
  paymentMethodCode: ExternalSalePaymentMethod | ""
  status: ExternalSaleActiveStatus
  declaredProfit: string
  notes: string
  stockEffect: ExternalSaleStockEffect | ""
  reason: string
}

interface CatalogOption {
  key: string
  label: string
  sku: string | null
  productId: number
  variantId: number | null
  stock: number
  active: boolean
}

function amountText(value: number | null | undefined) {
  return value == null ? "" : String(value).replace(".", ",")
}

function initialForm(sale: ExternalSaleListItem | null): FormState {
  if (!sale) {
    return {
      saleDate: argentinaToday(), customerName: "", channel: "whatsapp", catalogKey: "", sku: "", productName: "",
      quantity: "1", finalPrice: "", shippingAmount: "0", paymentMethodCode: "", status: "completed",
      declaredProfit: "", notes: "", stockEffect: "", reason: "",
    }
  }
  return {
    saleDate: sale.sale_date.slice(0, 10),
    customerName: sale.customer_name ?? "",
    channel: sale.channel ?? "other",
    catalogKey: "",
    sku: sale.sku ?? "",
    productName: sale.product_name,
    quantity: String(sale.quantity),
    finalPrice: amountText(sale.gross_amount),
    shippingAmount: amountText(sale.shipping_amount),
    paymentMethodCode: sale.payment_method_code ?? "",
    status: sale.status === "delivered" ? "delivered" : "completed",
    declaredProfit: amountText(sale.declared_profit),
    notes: sale.notes ?? "",
    stockEffect: sale.stock_effect,
    reason: "",
  }
}

function catalogOptions(products: ExternalSaleCatalogProduct[]): CatalogOption[] {
  return products.flatMap<CatalogOption>((product) => {
    const variants = product.producto_variantes ?? []
    if (!variants.length) {
      return [{
        key: `p:${product.id}`, label: product.nombre, sku: product.sku, productId: product.id, variantId: null,
        stock: product.stock, active: product.activo,
      }]
    }
    return variants.map((variant) => ({
      key: `v:${variant.id}`, label: `${product.nombre} · ${variant.nombre}`, sku: variant.sku, productId: product.id,
      variantId: variant.id, stock: variant.stock, active: product.activo && variant.activo,
    }))
  })
}

/** Alta manual o edición de una venta externa (la base valida stock, reservas y versión). */
export function ExternalSaleFormModal({
  open,
  sale,
  onClose,
  onSaved,
}: {
  open: boolean
  sale: ExternalSaleListItem | null
  onClose: () => void
  onSaved: (sale: ExternalSaleListItem, message: string) => void
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(sale))
  const [catalog, setCatalog] = useState<ExternalSaleCatalogProduct[]>([])
  const [catalogError, setCatalogError] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const attempt = useRef<IdempotencyAttempt | null>(null)
  const editing = sale !== null

  useEffect(() => {
    if (!open) return
    let active = true
    getExternalSalesCatalog()
      .then((products) => { if (active) setCatalog(products) })
      .catch((loadError) => {
        if (active) setCatalogError(loadError instanceof Error ? loadError.message : "No se pudo cargar el catálogo.")
      })
    return () => { active = false }
  }, [open])

  const options = useMemo(() => catalogOptions(catalog), [catalog])
  const selected = options.find((option) => option.key === form.catalogKey) ?? null
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => setForm((current) => ({ ...current, [field]: value }))

  const selectCatalog = (key: string) => {
    const option = options.find((item) => item.key === key)
    setForm((current) => ({
      ...current,
      catalogKey: key,
      sku: option?.sku ?? "",
      productName: option ? option.label : current.productName,
    }))
  }

  const fields = (): ExternalSaleFields | string => {
    const quantity = Number(form.quantity)
    const finalPrice = parseExternalSaleAmount(form.finalPrice)
    const shipping = parseExternalSaleAmount(form.shippingAmount)
    const profit = parseExternalSaleAmount(form.declaredProfit)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.saleDate) || form.saleDate > argentinaToday()) return "Elegí una fecha de venta válida (no futura)."
    if (!Number.isInteger(quantity) || quantity < 1) return "La cantidad debe ser un entero mayor a cero."
    if (finalPrice == null || Number.isNaN(finalPrice) || finalPrice < 0) return "Indicá el precio final que pagó el cliente."
    if (shipping != null && (Number.isNaN(shipping) || shipping < 0)) return "El envío debe ser un importe mayor o igual a cero."
    if (profit != null && Number.isNaN(profit)) return "La ganancia declarada no es un número válido."
    if (!form.sku.trim() && !selected) return "Indicá el SKU o elegí el producto del catálogo."
    return {
      saleDate: form.saleDate,
      customerName: form.customerName.trim() || null,
      channel: form.channel,
      sku: form.sku.trim() || null,
      productName: form.productName.trim() || null,
      quantity,
      shippingAmount: shipping ?? 0,
      paymentMethodCode: form.paymentMethodCode || null,
      status: form.status,
      finalPrice,
      declaredProfit: profit,
      notes: form.notes.trim() || null,
    }
  }

  const changedFields = (next: ExternalSaleFields, current: ExternalSaleListItem): Partial<ExternalSaleFields> => {
    const original: ExternalSaleFields = {
      saleDate: current.sale_date.slice(0, 10),
      customerName: current.customer_name,
      channel: current.channel ?? "other",
      sku: current.sku,
      productName: current.product_name,
      quantity: current.quantity,
      shippingAmount: Number(current.shipping_amount),
      paymentMethodCode: current.payment_method_code,
      status: current.status === "delivered" ? "delivered" : "completed",
      finalPrice: Number(current.gross_amount),
      declaredProfit: current.declared_profit == null ? null : Number(current.declared_profit),
      notes: current.notes,
    }
    const changes: Partial<ExternalSaleFields> = {}
    for (const field of Object.keys(next) as Array<keyof ExternalSaleFields>) {
      if (next[field] !== original[field]) Object.assign(changes, { [field]: next[field] })
    }
    // Un SKU nuevo sin nombre propio toma el nombre del catálogo en la base.
    if ("sku" in changes && !selected && changes.productName === undefined) changes.productName = null
    return changes
  }

  const save = async () => {
    if (savingRef.current) return
    const next = fields()
    if (typeof next === "string") {
      setError(next)
      return
    }
    if (!editing && !form.stockEffect) {
      setError("Elegí si la venta es Nueva (descuenta stock) o Histórica (no mueve stock).")
      return
    }
    savingRef.current = true
    setSaving(true)
    setError("")
    try {
      if (sale) {
        const changes = changedFields(next, sale)
        if (!Object.keys(changes).length) {
          setError("No hay cambios para guardar.")
          return
        }
        if (changes.sku === null) {
          setError("Indicá el SKU del producto vendido.")
          return
        }
        const saved = await updateExternalSale(sale.id, sale.version, changes, form.reason.trim())
        onSaved(saved, "Venta actualizada.")
      } else {
        const payload = {
          ...next,
          stockEffect: form.stockEffect as ExternalSaleStockEffect,
          productId: next.sku ? null : selected?.productId ?? null,
          variantId: next.sku ? null : selected?.variantId ?? null,
        }
        attempt.current = getOrCreateIdempotencyAttempt(attempt.current, payload, "external-sale")
        const saved = await createExternalSale(payload, attempt.current.key)
        attempt.current = null
        onSaved(saved, payload.stockEffect === "consume"
          ? "Venta registrada. El stock se descontó."
          : "Venta histórica registrada. El stock no se modificó.")
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar la venta.")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <AdminModal
      open={open}
      wide
      eyebrow="Ventas externas"
      title={editing ? "Editar venta" : "Nueva venta"}
      description={editing
        ? "Los cambios de SKU o cantidad mueven stock sólo si la venta es Nueva."
        : "Registrá una venta realizada fuera de la tienda web y de Mercado Libre."}
      onClose={() => { if (!savingRef.current) onClose() }}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <AdminSecondaryButton disabled={saving} onClick={onClose}>Cancelar</AdminSecondaryButton>
          <AdminPrimaryButton disabled={saving} onClick={() => void save()}>
            {saving ? "Guardando…" : editing ? "Guardar cambios" : "Registrar venta"}
          </AdminPrimaryButton>
        </div>
      }
    >
      <div className="space-y-4">
        {sale ? (
          <AdminInfoBlock tone="info">
            Tipo: <strong>{EXTERNAL_SALE_STOCK_EFFECT_LABELS[sale.stock_effect]}</strong>
            {sale.stock_effect === "none" ? " — editar SKU o cantidad no mueve stock." : " — editar SKU o cantidad ajusta el stock en la misma operación."}
          </AdminInfoBlock>
        ) : (
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">Tipo de venta</legend>
            {(["consume", "none"] as const).map((effect) => (
              <label key={effect} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/72 has-checked:border-beyonix-sky/50">
                <input
                  type="radio"
                  name="external-sale-stock-effect"
                  checked={form.stockEffect === effect}
                  onChange={() => set("stockEffect", effect)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-black text-white">{EXTERNAL_SALE_STOCK_EFFECT_LABELS[effect]}</span>
                  {effect === "consume"
                    ? "Venta recién hecha: descuenta stock al confirmar, respetando las reservas de la tienda web."
                    : "Venta anterior que el stock físico actual ya contempla: no modifica el stock."}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AdminFormField label="Fecha de venta">
            <AdminDatePicker title="Fecha de venta" ariaLabel="Fecha de venta" value={form.saleDate} onChange={(value) => set("saleDate", value)} />
          </AdminFormField>
          <AdminFormField label="Cliente">
            <AdminTextInput title="Cliente" placeholder="Nombre y apellido" value={form.customerName} maxLength={180} onChange={(value) => set("customerName", value)} />
          </AdminFormField>
          <AdminFormField label="Canal">
            <AdminSelect title="Canal" value={form.channel} onChange={(value) => set("channel", value as ExternalSaleChannel)}>
              {EXTERNAL_SALE_CHANNELS.map((channel) => <option key={channel} value={channel}>{EXTERNAL_SALE_CHANNEL_LABELS[channel]}</option>)}
            </AdminSelect>
          </AdminFormField>
          <AdminFormField label="Producto del catálogo" className="sm:col-span-2" help={catalogError || (selected ? `Stock actual: ${selected.stock}${selected.active ? "" : " · archivado"}` : "Opcional: completa SKU y nombre.")}>
            <AdminSelect title="Producto del catálogo" value={form.catalogKey} searchable searchPlaceholder="Buscar por nombre o SKU…" onChange={selectCatalog}>
              <option value="">Elegir del catálogo</option>
              {options.map((option) => (
                <option key={option.key} value={option.key} data-search={`${option.label} ${option.sku ?? ""}`} data-meta={option.sku ?? undefined}>
                  {option.active ? option.label : `${option.label} (archivado)`}
                </option>
              ))}
            </AdminSelect>
          </AdminFormField>
          <AdminFormField label="SKU">
            <AdminTextInput title="SKU" placeholder="SKU vendido" value={form.sku} maxLength={120} onChange={(value) => setForm((current) => ({ ...current, sku: value, catalogKey: "" }))} />
          </AdminFormField>
          <AdminFormField label="Nombre del producto" className="sm:col-span-2" help="Se guarda como estaba al vender, aunque después se renombre.">
            <AdminTextInput title="Nombre del producto" placeholder="Si queda vacío se usa el del catálogo" value={form.productName} maxLength={240} onChange={(value) => set("productName", value)} />
          </AdminFormField>
          <AdminFormField label="Cantidad">
            <AdminTextInput title="Cantidad" placeholder="1" inputMode="numeric" value={form.quantity} onChange={(value) => set("quantity", value.replace(/\D/g, ""))} />
          </AdminFormField>
          <AdminFormField label="Precio final" help="Lo que pagó el cliente por esta fila.">
            <AdminTextInput title="Precio final" placeholder="0,00" inputMode="decimal" value={form.finalPrice} onChange={(value) => set("finalPrice", value)} />
          </AdminFormField>
          <AdminFormField label="Envío" help="Sólo el costo logístico que pagó BEYONIX. Si el cliente pagó su envío, dejalo en $0.">
            <AdminTextInput title="Envío" placeholder="0,00" inputMode="decimal" value={form.shippingAmount} onChange={(value) => set("shippingAmount", value)} />
          </AdminFormField>
          <AdminFormField label="Medio de pago" help="Dato declarado: no se verifica con Mercado Pago.">
            <AdminSelect title="Medio de pago" value={form.paymentMethodCode} onChange={(value) => set("paymentMethodCode", value as ExternalSalePaymentMethod | "")}>
              <option value="">Sin especificar</option>
              {EXTERNAL_SALE_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{EXTERNAL_SALE_PAYMENT_LABELS[method]}</option>)}
            </AdminSelect>
          </AdminFormField>
          <AdminFormField label="Estado">
            <AdminSelect title="Estado" value={form.status} onChange={(value) => set("status", value === "delivered" ? "delivered" : "completed")}>
              <option value="completed">Confirmada</option>
              <option value="delivered">Entregada</option>
            </AdminSelect>
          </AdminFormField>
          <AdminFormField label="Ganancia declarada" help="Opcional. En ventas históricas es la que se reporta.">
            <AdminTextInput title="Ganancia declarada" placeholder="Opcional" inputMode="decimal" value={form.declaredProfit} onChange={(value) => set("declaredProfit", value)} />
          </AdminFormField>
          <AdminFormField label="Observación" className="sm:col-span-2 lg:col-span-3">
            <AdminTextarea title="Observación" value={form.notes} maxLength={1000} rows={2} className="min-h-16" onChange={(value) => set("notes", value)} />
          </AdminFormField>
          {editing && (
            <AdminFormField label="Motivo de la edición" className="sm:col-span-2 lg:col-span-3" help="Opcional. Queda en el historial de la venta.">
              <AdminTextInput title="Motivo de la edición" placeholder="Ej.: cantidad mal cargada" value={form.reason} maxLength={500} onChange={(value) => set("reason", value)} />
            </AdminFormField>
          )}
        </div>
        {error && <p role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</p>}
      </div>
    </AdminModal>
  )
}
