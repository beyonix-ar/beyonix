"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  CircleDollarSign,
  Package,
  Pencil,
  RefreshCw,
  ShoppingBag,
  X,
} from "lucide-react"

import { formatPrice } from "../productos/helpers"
import {
  deleteSalesLedgerRow,
  getSalesLedger,
  saveSalesLedgerRow,
  type SalesLedgerCatalogProduct,
  type SalesLedgerChannel,
  type SalesLedgerRow,
} from "@/lib/supabase/queries/sales-ledger"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { AdminSelect } from "../../components/admin-controls"

interface SaleForm {
  saleDate: string
  productId: string
  productName: string
  sku: string
  quantity: string
  unitPrice: string
  unitCost: string
  shippingAmount: string
  feeType: "amount" | "percent"
  feeValue: string
  otherExpenseAmount: string
  paymentMethod: string
  reference: string
  customerName: string
  notes: string
}

function localDate() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function emptyForm(): SaleForm {
  return {
    saleDate: localDate(),
    productId: "",
    productName: "",
    sku: "",
    quantity: "1",
    unitPrice: "",
    unitCost: "",
    shippingAmount: "",
    feeType: "amount",
    feeValue: "",
    otherExpenseAmount: "",
    paymentMethod: "",
    reference: "",
    customerName: "",
    notes: "",
  }
}

function number(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateOnly(value: string) {
  return value.slice(0, 10)
}

function formFromRow(row: SalesLedgerRow): SaleForm {
  return {
    saleDate: dateOnly(row.sale_date),
    productId: row.product_id ? String(row.product_id) : "",
    productName: row.product_name,
    sku: row.sku ?? "",
    quantity: String(row.quantity),
    unitPrice: String(row.unit_price ?? (row.quantity ? row.gross_amount / row.quantity : 0)),
    unitCost: String(row.unit_cost ?? 0),
    shippingAmount: String(row.shipping_amount ?? 0),
    feeType: row.fee_type ?? "amount",
    feeValue: String(row.fee_value ?? row.fee_amount ?? 0),
    otherExpenseAmount: String(row.other_expense_amount ?? 0),
    paymentMethod: row.payment_method ?? "",
    reference: row.reference ?? "",
    customerName: row.customer_name ?? "",
    notes: row.notes ?? "",
  }
}

const inputClass =
  "h-11 w-full min-w-0 rounded-xl border border-beyonix-blue-light/18 bg-[#07111B] px-3 text-center text-sm font-bold text-white outline-none transition placeholder:text-white/28 hover:border-beyonix-sky/30 focus:border-beyonix-sky/55"

function numeric(value: string) {
  return value.replace(/[^\d.,]/g, "").replace(",", ".")
}

function integer(value: string) {
  return value.replace(/\D/g, "")
}

function MoneyInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
}) {
  return (
    <div data-sales-nav-field className="relative min-w-36">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-black text-beyonix-sky">
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(numeric(event.target.value))}
        placeholder="0,00"
        className={`${inputClass} min-w-36 px-7 tabular-nums`}
      />
    </div>
  )
}

export function AdminSalesLedger({
  channel,
}: {
  channel: SalesLedgerChannel
}) {
  const formAnchor = useRef<HTMLDivElement>(null)
  const [rows, setRows] = useState<SalesLedgerRow[]>([])
  const [catalog, setCatalog] = useState<SalesLedgerCatalogProduct[]>([])
  const [form, setForm] = useState<SaleForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const title = channel === "external" ? "Ventas externas" : "Ventas ML"
  const description =
    channel === "external"
      ? "Registrá las ventas realizadas fuera de la tienda, junto con todos sus costos."
      : "Cargá, corregí o eliminá ventas de Mercado Libre de forma manual."

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const data = await getSalesLedger()
      setCatalog(data.catalog)
      setRows(channel === "external" ? data.externalSales : data.mlSales)
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "No se pudieron cargar las ventas.",
      )
    } finally {
      setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    void load()
  }, [load])

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          const gross = number(row.gross_amount)
          const catalogUnitCost =
            catalog.find((product) => product.id === row.product_id)?.unit_cost ?? 0
          const effectiveUnitCost =
            number(row.unit_cost) > 0 ? number(row.unit_cost) : number(catalogUnitCost)
          const expenses =
            effectiveUnitCost * number(row.quantity) +
            number(row.shipping_amount) +
            number(row.fee_amount) +
            number(row.other_expense_amount)
          acc.units += number(row.quantity)
          acc.gross += gross
          acc.result += gross - expenses
          return acc
        },
        { units: 0, gross: 0, result: 0 },
      ),
    [catalog, rows],
  )

  const draftGross = number(form.quantity) * number(form.unitPrice)
  const draftFee =
    form.feeType === "percent"
      ? draftGross * (number(form.feeValue) / 100)
      : number(form.feeValue)
  const draftExpenses =
    number(form.quantity) * number(form.unitCost) +
    number(form.shippingAmount) +
    draftFee +
    number(form.otherExpenseAmount)
  const draftResult = draftGross - draftExpenses

  const update = <K extends keyof SaleForm>(field: K, value: SaleForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const selectProduct = (productId: string) => {
    const product = catalog.find((item) => String(item.id) === productId)
    setForm((current) => ({
      ...current,
      productName: product?.nombre ?? current.productName,
      productId,
      sku: product?.sku ?? "",
      unitPrice:
        product && current.productId !== productId
          ? String(product.precio)
          : current.unitPrice,
      unitCost:
        product && current.productId !== productId && product.unit_cost != null
          ? String(product.unit_cost)
          : current.unitCost,
    }))
  }

  const reset = () => {
    setForm(emptyForm())
    setEditingId(null)
    setError("")
  }

  const handleFieldNavigation = (
    event: React.KeyboardEvent<HTMLTableRowElement>,
  ) => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return
    }

    const target = event.target as HTMLElement
    const currentField = target.closest<HTMLElement>("[data-sales-nav-field]")
    if (!currentField) return

    if (target instanceof HTMLInputElement) {
      const cursorStart = target.selectionStart
      const cursorEnd = target.selectionEnd
      const hasSelection =
        cursorStart != null && cursorEnd != null && cursorStart !== cursorEnd

      if (hasSelection) return
      if (event.key === "ArrowLeft" && cursorStart != null && cursorStart > 0) return
      if (
        event.key === "ArrowRight" &&
        cursorEnd != null &&
        cursorEnd < target.value.length
      ) {
        return
      }
    }

    const fields = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-sales-nav-field]"),
    )
    const currentIndex = fields.indexOf(currentField)
    const direction =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1
    const nextField = fields[currentIndex + direction]
    const nextControl = nextField?.querySelector<HTMLElement>(
      'input:not(:disabled), button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )

    if (!nextControl) return
    event.preventDefault()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    nextControl.focus()
    if (nextControl instanceof HTMLInputElement) {
      const cursor = direction > 0 ? 0 : nextControl.value.length
      nextControl.setSelectionRange(cursor, cursor)
    }
  }

  const save = async () => {
    if (!form.saleDate || !form.productName.trim() || number(form.quantity) <= 0) {
      setError("Completá la fecha, el producto y una cantidad mayor a cero.")
      return
    }

    setSaving(true)
    setError("")
    setSuccess("")
    try {
      const selectedProduct = catalog.find(
        (product) => String(product.id) === form.productId,
      )
      await saveSalesLedgerRow(
        {
          channel,
          ...form,
          productId:
            typeof selectedProduct?.id === "number" ? selectedProduct.id : null,
          quantity: Number(form.quantity),
          unitPrice: number(form.unitPrice),
          unitCost: number(form.unitCost),
          shippingAmount: number(form.shippingAmount),
          feeType: form.feeType,
          feeValue: number(form.feeValue),
          otherExpenseAmount: number(form.otherExpenseAmount),
        },
        editingId ?? undefined,
      )
      setSuccess(editingId ? "Venta actualizada correctamente." : "Venta agregada correctamente.")
      reset()
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar la venta.")
    } finally {
      setSaving(false)
    }
  }

  const edit = (row: SalesLedgerRow) => {
    setEditingId(row.id)
    const nextForm = formFromRow(row)
    if (!row.product_id) {
      const matchingStandalone = catalog.find(
        (product) =>
          typeof product.id === "string" &&
          product.nombre.localeCompare(row.product_name, "es", { sensitivity: "base" }) === 0 &&
          (!row.sku || product.sku?.localeCompare(row.sku, "es", { sensitivity: "base" }) === 0),
      )
      if (matchingStandalone) nextForm.productId = String(matchingStandalone.id)
    }
    const catalogUnitCost =
      catalog.find((product) => product.id === row.product_id)?.unit_cost ?? null
    if (number(row.unit_cost) === 0 && catalogUnitCost != null) {
      nextForm.unitCost = String(catalogUnitCost)
    }
    setForm(nextForm)
    setError("")
    setSuccess("")
    formAnchor.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  const remove = async (row: SalesLedgerRow) => {
    if (!window.confirm(`¿Eliminar la venta de “${row.product_name}”? Esta acción no se puede deshacer.`)) {
      return
    }
    setDeletingId(row.id)
    setError("")
    try {
      await deleteSalesLedgerRow(channel, row.id)
      setRows((current) => current.filter((item) => item.id !== row.id))
      if (editingId === row.id) reset()
      setSuccess("Venta eliminada.")
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "No se pudo eliminar la venta.",
      )
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-beyonix-blue-light/18 bg-[linear-gradient(145deg,rgba(7,16,24,0.9),rgba(3,7,13,0.98))] p-4">
        <div>
          <div>
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              Registro comercial
            </p>
            <h2 className="mt-1 text-2xl font-black text-white">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-white/55">{description}</p>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/8 bg-black/25 p-3 text-center">
            <ShoppingBag className="mx-auto size-4 text-beyonix-sky" />
            <p className="mt-1.5 text-10px font-black uppercase tracking-widest text-white/40">
              Ventas registradas
            </p>
            <p className="mt-1 text-xl font-black text-white">{rows.length}</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/25 p-3 text-center">
            <Package className="mx-auto size-4 text-beyonix-sky" />
            <p className="mt-1.5 text-10px font-black uppercase tracking-widest text-white/40">
              Unidades vendidas
            </p>
            <p className="mt-1 text-xl font-black text-white">{totals.units}</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/25 p-3 text-center">
            <CircleDollarSign className="mx-auto size-4 text-beyonix-sky" />
            <p className="mt-1.5 text-10px font-black uppercase tracking-widest text-white/40">
              Facturación total
            </p>
            <p className="mt-1 text-xl font-black text-white">
              {formatPrice(totals.gross)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/25 p-3 text-center">
            <CircleDollarSign className="mx-auto size-4 text-emerald-300" />
            <p className="mt-1.5 text-10px font-black uppercase tracking-widest text-white/40">
              Ganancia obtenida
            </p>
            <p className={`mt-1 text-xl font-black ${totals.result >= 0 ? "text-emerald-300" : "text-red-300"}`}>
              {formatPrice(totals.result)}
            </p>
          </div>
        </div>
      </section>

      <section
        ref={formAnchor}
        className="rounded-3xl border border-beyonix-blue-light/18 bg-[#071018] p-4 sm:p-5"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-black text-white">
              {editingId ? "Editar venta" : "Agregar una venta"}
            </p>
            <p className="mt-1 text-xs text-white/42">
              La nueva venta aparecerá debajo de esta fila.
            </p>
          </div>
          {editingId && (
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-bold text-white/60 hover:text-white"
            >
              <X className="size-3.5" />
              Cancelar edición
            </button>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-xl border border-red-400/20 bg-red-400/9 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}
        {success && (
          <p className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-400/9 px-4 py-3 text-sm text-emerald-200">
            {success}
          </p>
        )}

        <div className="sales-ledger-scrollbar overflow-x-auto rounded-2xl border border-beyonix-blue-light/16 bg-black/20">
          <table className="w-full min-w-[2250px] text-center">
            <thead>
              <tr className="text-10px font-black uppercase tracking-widest text-white/38">
                {[
                  ["Fecha", "w-[150px]"],
                  ["Producto", "w-60"],
                  ["SKU", "w-32"],
                  ["Costo unitario", "w-36"],
                  ["Cantidad", "w-20"],
                  ["Precio venta", "w-36"],
                  ["Envío pagado", "w-36"],
                  ["Comisión", "w-36"],
                  ["Otros gastos", "w-36"],
                  ["Medio de pago", "w-40"],
                  ["Referencia", "w-40"],
                  ["Cliente", "w-48"],
                  ["Notas", "w-52"],
                  ["Total", "w-32"],
                  ["Ganancia neta", "w-36"],
                  ["Acciones", "w-24"],
                ].map(([label, width]) => (
                  <th key={label} className={`px-2 py-3 text-center ${width}`}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr
                onKeyDownCapture={handleFieldNavigation}
                className="border-t border-white/7 bg-beyonix-blue/7"
              >
                <td className="p-2">
                  <div data-sales-nav-field className="w-[150px] min-w-[150px]">
                    <AdminDatePicker
                      title={`Fecha de venta ${channel}`}
                      ariaLabel="Fecha de venta"
                      value={form.saleDate}
                      onChange={(value) => update("saleDate", value)}
                      centered
                      compact
                    />
                  </div>
                </td>
                <td data-sales-nav-field className="p-2">
                  <AdminSelect
                    title="Producto"
                    ariaLabel="Seleccionar producto"
                    value={form.productId}
                    onChange={selectProduct}
                    centered
                    searchable
                    searchPlaceholder="Buscar por nombre o SKU..."
                    triggerClassName="sales-ledger-product-trigger min-w-56"
                    optionClassName="sales-ledger-product-option justify-center text-center"
                  >
                    <option value="">Seleccionar producto</option>
                    {catalog.map((product) => (
                      <option
                        key={product.id}
                        value={String(product.id)}
                        data-search={`${product.nombre} ${product.sku ?? ""}`}
                        data-meta={product.sku ?? undefined}
                        data-selected-label={product.nombre}
                      >
                        {product.nombre}
                      </option>
                    ))}
                  </AdminSelect>
                </td>
                <td data-sales-nav-field className="p-2">
                  <input
                    aria-label="SKU"
                    value={form.sku}
                    onChange={(event) => update("sku", event.target.value)}
                    placeholder="Opcional"
                    className={`${inputClass} min-w-28`}
                  />
                </td>
                <td className="p-2">
                  <MoneyInput value={form.unitCost} onChange={(value) => update("unitCost", value)} ariaLabel="Costo unitario" />
                </td>
                <td data-sales-nav-field className="p-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Cantidad vendida"
                    value={form.quantity}
                    onChange={(event) => update("quantity", integer(event.target.value))}
                    className={`${inputClass} min-w-16 px-2 tabular-nums`}
                  />
                </td>
                <td className="p-2">
                  <MoneyInput value={form.unitPrice} onChange={(value) => update("unitPrice", value)} ariaLabel="Precio de venta" />
                </td>
                <td className="p-2">
                  <MoneyInput value={form.shippingAmount} onChange={(value) => update("shippingAmount", value)} ariaLabel="Envío pagado" />
                </td>
                <td className="p-2">
                  <div className="flex min-w-[182px] items-center gap-1.5">
                    <div data-sales-nav-field className="w-16 shrink-0">
                    <AdminSelect
                      title="Tipo de comisión"
                      ariaLabel="Tipo de comisión"
                      value={form.feeType}
                      onChange={(value) =>
                        update(
                          "feeType",
                          value === "percent" ? "percent" : "amount",
                        )
                      }
                      triggerClassName="!w-16 !min-w-16 !gap-2 !px-3 !text-sm font-bold"
                      menuClassName="!w-16"
                      optionClassName="sales-ledger-fee-option justify-center text-center font-bold [&>svg]:hidden"
                    >
                      <option value="amount">$</option>
                      <option value="percent">%</option>
                    </AdminSelect>
                    </div>
                    <div data-sales-nav-field className="min-w-28 flex-1">
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label="Valor de la comisión"
                      value={form.feeValue}
                      onChange={(event) => update("feeValue", numeric(event.target.value))}
                      placeholder="0,00"
                      className={`${inputClass} min-w-28 px-3 tabular-nums`}
                    />
                    </div>
                  </div>
                </td>
                <td className="p-2">
                  <MoneyInput value={form.otherExpenseAmount} onChange={(value) => update("otherExpenseAmount", value)} ariaLabel="Otros gastos" />
                </td>
                <td data-sales-nav-field className="p-2">
                  <input
                    aria-label="Medio de pago"
                    value={form.paymentMethod}
                    onChange={(event) => update("paymentMethod", event.target.value)}
                    placeholder="Efectivo, transferencia..."
                    className={`${inputClass} min-w-36`}
                  />
                </td>
                <td data-sales-nav-field className="p-2">
                  <input
                    aria-label="Referencia"
                    value={form.reference}
                    onChange={(event) => update("reference", event.target.value)}
                    placeholder="N.º de operación"
                    className={`${inputClass} min-w-36`}
                  />
                </td>
                <td data-sales-nav-field className="p-2">
                  <input
                    aria-label="Cliente"
                    value={form.customerName}
                    onChange={(event) => update("customerName", event.target.value)}
                    placeholder="Nombre y apellido"
                    className={`${inputClass} min-w-44`}
                  />
                </td>
                <td data-sales-nav-field className="p-2">
                  <input
                    aria-label="Notas"
                    value={form.notes}
                    onChange={(event) => update("notes", event.target.value)}
                    placeholder="Observaciones"
                    className={`${inputClass} min-w-48`}
                  />
                </td>
                <td className="px-3 py-2 text-sm font-black tabular-nums text-white">
                  {formatPrice(draftGross)}
                </td>
                <td className={`px-3 py-2 text-sm font-black tabular-nums ${draftResult >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                  {formatPrice(draftResult)}
                </td>
                <td data-sales-nav-field className="p-2">
                  <button
                    type="button"
                    aria-label={editingId ? "Guardar cambios" : "Agregar venta"}
                    title={editingId ? "Guardar cambios" : "Agregar venta"}
                    onClick={() => void save()}
                    disabled={saving}
                    className="flex size-9 cursor-pointer items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-400/15 text-emerald-200 transition hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? <RefreshCw className="size-4 animate-spin" /> : <Check className="size-4" strokeWidth={3} />}
                  </button>
                </td>
              </tr>

              {rows.map((row) => {
                const gross = number(row.gross_amount)
                const catalogUnitCost =
                  catalog.find((product) => product.id === row.product_id)?.unit_cost ?? 0
                const effectiveUnitCost =
                  number(row.unit_cost) > 0
                    ? number(row.unit_cost)
                    : number(catalogUnitCost)
                const result =
                  gross -
                  effectiveUnitCost * number(row.quantity) -
                  number(row.shipping_amount) -
                  number(row.fee_amount) -
                  number(row.other_expense_amount)
                return (
                  <tr
                    key={row.id}
                    className={`border-t border-white/6 text-xs text-white/62 transition hover:bg-white/3 ${editingId === row.id ? "bg-beyonix-blue/12" : ""}`}
                  >
                    <td className="whitespace-nowrap px-3 py-3 text-center">{dateOnly(row.sale_date).split("-").reverse().join("/")}</td>
                    <td className="max-w-60 px-3 py-3 text-center font-black text-white">
                      <span className="block truncate" title={row.product_name}>{row.product_name}</span>
                    </td>
                    <td className="px-3 py-3">{row.sku || "—"}</td>
                    <td className="px-3 py-3 tabular-nums">{formatPrice(effectiveUnitCost)}</td>
                    <td className="px-3 py-3 tabular-nums">{row.quantity}</td>
                    <td className="px-3 py-3 tabular-nums">{formatPrice(number(row.unit_price ?? gross / Math.max(1, row.quantity)))}</td>
                    <td className="px-3 py-3 tabular-nums">{formatPrice(number(row.shipping_amount))}</td>
                    <td className="px-3 py-3 tabular-nums">
                      {row.fee_type === "percent"
                        ? `${number(row.fee_value).toLocaleString("es-AR")}% · ${formatPrice(number(row.fee_amount))}`
                        : formatPrice(number(row.fee_amount))}
                    </td>
                    <td className="px-3 py-3 tabular-nums">{formatPrice(number(row.other_expense_amount))}</td>
                    <td className="px-3 py-3">{row.payment_method || "—"}</td>
                    <td className="max-w-40 px-3 py-3">
                      <span className="block truncate" title={row.reference ?? ""}>{row.reference || "—"}</span>
                    </td>
                    <td className="max-w-48 px-3 py-3">
                      <span className="block truncate" title={row.customer_name ?? ""}>{row.customer_name || "—"}</span>
                    </td>
                    <td className="max-w-52 px-3 py-3">
                      <span className="block truncate" title={row.notes ?? ""}>{row.notes || "—"}</span>
                    </td>
                    <td className="px-3 py-3 font-black tabular-nums text-white">{formatPrice(gross)}</td>
                    <td className={`px-3 py-3 font-black tabular-nums ${result >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                      {formatPrice(result)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex justify-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`Editar venta de ${row.product_name}`}
                          title="Editar"
                          onClick={() => edit(row)}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-beyonix-sky/22 bg-beyonix-blue/24 text-beyonix-sky transition hover:border-beyonix-sky/45 hover:bg-beyonix-blue/40"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Eliminar venta de ${row.product_name}`}
                          title="Eliminar"
                          onClick={() => void remove(row)}
                          disabled={deletingId === row.id}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-red-400/20 bg-red-400/8 text-red-300 transition hover:border-red-400/40 hover:bg-red-400/15 disabled:opacity-50"
                        >
                          {deletingId === row.id ? <RefreshCw className="size-3.5 animate-spin" /> : <X className="size-3.5" strokeWidth={2.5} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <div className="border-t border-white/7 px-5 py-10 text-center">
              <ShoppingBag className="mx-auto size-7 text-white/22" />
              <p className="mt-3 text-sm font-bold text-white/45">
                Todavía no hay ventas registradas.
              </p>
              <p className="mt-1 text-xs text-white/30">
                Completá la primera fila y presioná el check verde.
              </p>
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center gap-2 border-t border-white/7 px-5 py-10 text-sm text-white/45">
              <RefreshCw className="size-4 animate-spin" />
              Cargando ventas...
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
