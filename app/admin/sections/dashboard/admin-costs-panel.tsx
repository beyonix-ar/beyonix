"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Trash2,
  WalletCards,
} from "lucide-react"

import {
  createBusinessCost,
  deleteBusinessCost,
  getBusinessCosts,
  type BusinessCostsData,
} from "@/lib/supabase/queries/business-costs"
import { formatPrice } from "../productos/helpers"
import { AdminDatePicker } from "../../components/admin-date-picker"

type CostMode = "product" | "expense"

const inputClass =
  "h-10 min-w-0 w-full rounded-xl border border-beyonix-blue-light/18 bg-[#07111B] px-3 text-center text-sm font-bold text-white outline-none transition placeholder:text-white/28 hover:border-beyonix-sky/30 focus:border-beyonix-sky/55"

const EXPENSE_CATEGORIES = [
  "Monotributo",
  "Impuestos",
  "Contador",
  "Servicios",
  "Software",
  "Publicidad",
  "Alquiler",
  "Sueldos",
  "Logística",
  "Comisiones",
  "Bancos",
  "Mantenimiento",
  "Insumos",
  "Seguros",
  "Otros",
]

function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date())
}

function numeric(value: string) {
  return value.replace(/[^\d.,]/g, "").replace(",", ".")
}

function Field({ label, children, className = "" }: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={`min-w-0 ${className}`}>
      <span className="mb-1.5 block text-center text-10px font-black uppercase tracking-widest text-white/42">
        {label}
      </span>
      {children}
    </label>
  )
}

function MoneyInput({ value, onChange, placeholder = "0" }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-black text-beyonix-sky">
        $
      </span>
      <input
        value={value}
        inputMode="decimal"
        placeholder={placeholder}
        onChange={(event) => onChange(numeric(event.target.value))}
        className={`${inputClass} pl-7`}
      />
    </div>
  )
}

function SummaryCard({ label, value, detail }: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-2xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-4 py-3">
      <p className="text-10px font-black uppercase tracking-widest text-white/40">{label}</p>
      <p className="mt-1 text-lg font-black tabular-nums text-white">{value}</p>
      <p className="mt-1 text-11px font-semibold text-white/38">{detail}</p>
    </div>
  )
}

function ProductSelect({
  value,
  products,
  onChange,
}: {
  value: string
  products: BusinessCostsData["catalog"]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = products.find((product) => `p:${product.id}` === value)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`${inputClass} flex cursor-pointer items-center justify-between gap-3 px-4 hover:bg-beyonix-blue/12 focus:border-beyonix-sky/55`}
      >
        <span className="size-4 shrink-0 text-beyonix-sky"><Boxes className="size-4" /></span>
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-white" : "text-white/48"}`}>
          {selected?.nombre ?? "Seleccionar producto"}
        </span>
        <ChevronDown className={`size-4 shrink-0 text-beyonix-sky transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-30 mt-2 max-h-280px overflow-y-auto rounded-2xl border border-beyonix-sky/28 bg-[#07131F] p-1.5 shadow-2xl shadow-black/60 custom-scrollbar">
          {products.map((product) => {
            const optionValue = `p:${product.id}`
            const active = optionValue === value
            return (
              <button
                key={product.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(optionValue)
                  setOpen(false)
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-bold transition ${active ? "bg-beyonix-blue/55 text-white" : "text-white/68 hover:bg-beyonix-blue/24 hover:text-white"}`}
              >
                <span className="truncate">{product.nombre}</span>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-10px font-black ${product.activo ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-300" : "border-white/10 bg-white/5 text-white/38"}`}>
                  {product.activo ? "Activo" : "Inactivo"}
                </span>
              </button>
            )
          })}
          {!products.length && <p className="px-3 py-4 text-center text-xs font-semibold text-white/42">No hay productos cargados.</p>}
        </div>
      )}
    </div>
  )
}

function ModernSelect({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`${inputClass} flex cursor-pointer items-center justify-between gap-3 px-4 hover:bg-beyonix-blue/12`}
      >
        <span className="w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? "Seleccionar"}</span>
        <ChevronDown className={`size-4 shrink-0 text-beyonix-sky transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-2xl border border-beyonix-sky/28 bg-[#07131F] p-1.5 shadow-2xl shadow-black/60">
          {options.map((option) => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition ${active ? "bg-beyonix-blue/55 text-white" : "text-white/68 hover:bg-beyonix-blue/24 hover:text-white"}`}
              >
                <span>{option.label}</span>
                {active && <Check className="size-4 text-emerald-300" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AdminCostsPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<BusinessCostsData | null>(null)
  const [mode, setMode] = useState<CostMode>("product")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [article, setArticle] = useState("")
  const [purchaseDate, setPurchaseDate] = useState(today)
  const [quantity, setQuantity] = useState("")
  const [unitCost, setUnitCost] = useState("")
  const [freightCost, setFreightCost] = useState("")
  const [taxCost, setTaxCost] = useState("")
  const [commissionCost, setCommissionCost] = useState("")
  const [otherCost, setOtherCost] = useState("")
  const [productSupplier, setProductSupplier] = useState("")
  const [productDocumentType, setProductDocumentType] = useState("")
  const [productDocumentNumber, setProductDocumentNumber] = useState("")
  const [productPaymentMethod, setProductPaymentMethod] = useState("")
  const [productNotes, setProductNotes] = useState("")
  const [expenseDate, setExpenseDate] = useState(today)
  const [expenseCategory, setExpenseCategory] = useState("Monotributo")
  const [expenseDescription, setExpenseDescription] = useState("")
  const [expenseAmount, setExpenseAmount] = useState("")
  const [expenseRecurrence, setExpenseRecurrence] = useState("mensual")
  const [expenseStatus, setExpenseStatus] = useState("pagado")
  const [expenseSupplier, setExpenseSupplier] = useState("")
  const [expensePaymentMethod, setExpensePaymentMethod] = useState("")
  const [expenseDocumentType, setExpenseDocumentType] = useState("")
  const [expenseDocumentNumber, setExpenseDocumentNumber] = useState("")
  const [expenseTaxDeductible, setExpenseTaxDeductible] = useState(false)
  const [expenseNotes, setExpenseNotes] = useState("")

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError("")
      setData(await getBusinessCosts())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron cargar los costos.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const productNames = useMemo(() => {
    const names = new Map<string, string>()
    data?.catalog.forEach((product) => {
      names.set(`p:${product.id}`, product.nombre)
      product.producto_variantes?.forEach((variant) => {
        names.set(`v:${product.id}:${variant.id}`, `${product.nombre} · ${variant.nombre}`)
      })
    })
    return names
  }, [data])

  const productInvestment = data?.productCosts.reduce(
    (total, item) => total + Number(item.total_cost),
    0,
  ) ?? 0
  const purchasedUnits = data?.productCosts.reduce(
    (total, item) => total + Number(item.quantity),
    0,
  ) ?? 0
  const paidExpenses = data?.expenses.reduce(
    (total, item) => total + (item.status === "pagado" ? Number(item.amount) : 0),
    0,
  ) ?? 0
  const pendingExpenses = data?.expenses.reduce(
    (total, item) => total + (item.status === "pendiente" ? Number(item.amount) : 0),
    0,
  ) ?? 0

  const saveProduct = async () => {
    const parts = article.split(":")
    const productId = parts[0] === "p" ? parts[1] : parts[1]
    const variantId = parts[0] === "v" ? parts[2] : null

    if (!productId || !purchaseDate || !quantity || !unitCost) {
      setError("Completá artículo, fecha, cantidad y costo unitario.")
      return
    }

    try {
      setSaving(true)
      setError("")
      setMessage("")
      await createBusinessCost({
        kind: "product",
        productId,
        variantId,
        purchaseDate,
        quantity,
        unitCost,
        freightCost,
        taxCost,
        commissionCost,
        otherCost,
        supplier: productSupplier,
        documentType: productDocumentType,
        documentNumber: productDocumentNumber,
        paymentMethod: productPaymentMethod,
        notes: productNotes,
      })
      setQuantity("")
      setUnitCost("")
      setFreightCost("")
      setTaxCost("")
      setCommissionCost("")
      setOtherCost("")
      setProductNotes("")
      setMessage("Compra guardada correctamente.")
      await load()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la compra.")
    } finally {
      setSaving(false)
    }
  }

  const saveExpense = async () => {
    if (!expenseDate || !expenseCategory || !expenseAmount) {
      setError("Completá fecha, categoría e importe.")
      return
    }

    try {
      setSaving(true)
      setError("")
      setMessage("")
      await createBusinessCost({
        kind: "expense",
        expenseDate,
        category: expenseCategory,
        description: expenseDescription,
        amount: expenseAmount,
        recurrence: expenseRecurrence,
        status: expenseStatus,
        supplier: expenseSupplier,
        paymentMethod: expensePaymentMethod,
        documentType: expenseDocumentType,
        documentNumber: expenseDocumentNumber,
        taxDeductible: expenseTaxDeductible,
        notes: expenseNotes,
      })
      setExpenseDescription("")
      setExpenseAmount("")
      setExpenseNotes("")
      setMessage("Gasto guardado correctamente.")
      await load()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar el gasto.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (kind: CostMode, id: string) => {
    if (!window.confirm("¿Querés eliminar este movimiento?")) return
    try {
      setError("")
      await deleteBusinessCost(kind, id)
      await load()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo eliminar el movimiento.")
    }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-240px items-center justify-center rounded-3xl border border-beyonix-blue-light/16 bg-[#071018]">
        <Loader2 className="size-6 animate-spin text-beyonix-sky" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-beyonix-blue-light/18 bg-[linear-gradient(145deg,rgba(7,16,24,0.9),rgba(3,7,13,0.96))] p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">Contabilidad interna</p>
            <h2 className="mt-1 text-2xl font-black text-white">Costos reales</h2>
            <p className="mt-1 text-xs font-semibold text-white/45">Compras, impuestos y gastos con historial.</p>
          </div>
          <div className="inline-flex rounded-2xl border border-beyonix-blue-light/20 bg-black/30 p-1">
            <button type="button" onClick={() => setMode("product")} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl px-4 text-xs font-black transition ${mode === "product" ? "bg-beyonix-blue/60 text-white" : "text-white/55 hover:text-white"}`}><Boxes className="size-4" /> Mercadería</button>
            <button type="button" onClick={() => setMode("expense")} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl px-4 text-xs font-black transition ${mode === "expense" ? "bg-beyonix-blue/60 text-white" : "text-white/55 hover:text-white"}`}><WalletCards className="size-4" /> Gastos</button>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Mercadería" value={formatPrice(productInvestment)} detail={`${purchasedUnits} unidades compradas`} />
          <SummaryCard label="Costo promedio" value={formatPrice(purchasedUnits ? productInvestment / purchasedUnits : 0)} detail="Integral por unidad" />
          <SummaryCard label="Gastos pagados" value={formatPrice(paidExpenses)} detail="Egresos registrados" />
          <SummaryCard label="Gastos pendientes" value={formatPrice(pendingExpenses)} detail="Obligaciones abiertas" />
        </div>
      </section>

      {(error || message) && (
        <div className={`flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold ${error ? "border-red-400/25 bg-red-400/10 text-red-200" : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"}`}>
          {error ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
          {error || message}
        </div>
      )}

      {mode === "product" ? (
        <>
          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2"><Plus className="size-4 text-beyonix-sky" /><h3 className="text-base font-black text-white">Nueva compra</h3></div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Artículo" className="xl:col-span-2"><ProductSelect value={article} products={data?.catalog ?? []} onChange={setArticle} /></Field>
              <Field label="Fecha compra"><AdminDatePicker title="Fecha compra" ariaLabel="Fecha de compra" value={purchaseDate} onChange={setPurchaseDate} centered /></Field>
              <Field label="Cantidad"><input value={quantity} inputMode="numeric" onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ""))} className={inputClass} placeholder="0" /></Field>
              <Field label="Costo unitario"><MoneyInput value={unitCost} onChange={setUnitCost} /></Field>
              <Field label="Proveedor"><input value={productSupplier} onChange={(event) => setProductSupplier(event.target.value)} className={inputClass} placeholder="Opcional" /></Field>
              <Field label="Flete"><MoneyInput value={freightCost} onChange={setFreightCost} /></Field>
              <Field label="Impuestos"><MoneyInput value={taxCost} onChange={setTaxCost} /></Field>
              <Field label="Comisiones"><MoneyInput value={commissionCost} onChange={setCommissionCost} /></Field>
              <Field label="Otros costos"><MoneyInput value={otherCost} onChange={setOtherCost} /></Field>
              <Field label="Comprobante"><input value={productDocumentType} onChange={(event) => setProductDocumentType(event.target.value)} className={inputClass} placeholder="Factura, recibo" /></Field>
              <Field label="Número"><input value={productDocumentNumber} onChange={(event) => setProductDocumentNumber(event.target.value)} className={inputClass} placeholder="Opcional" /></Field>
              <Field label="Medio pago"><input value={productPaymentMethod} onChange={(event) => setProductPaymentMethod(event.target.value)} className={inputClass} placeholder="Transferencia" /></Field>
              <Field label="Notas" className="xl:col-span-2"><input value={productNotes} onChange={(event) => setProductNotes(event.target.value)} className={inputClass} placeholder="Detalle adicional" /></Field>
            </div>
            <div className="mt-4 flex justify-end"><button type="button" disabled={saving} onClick={() => void saveProduct()} className="inline-flex h-10 min-w-130px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/35 bg-beyonix-blue/38 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/60 hover:bg-beyonix-blue/55 disabled:cursor-wait disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Guardar</button></div>
          </section>

          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-base font-black text-white">Historial de compras</h3><span className="text-xs font-bold text-white/38">{data?.productCosts.length ?? 0} registros</span></div>
            <div className="overflow-x-auto rounded-2xl border border-white/7">
              <table className="w-full min-w-1000px text-sm"><thead className="bg-black/30 text-10px uppercase tracking-widest text-white/42"><tr><th className="px-3 py-2.5 text-left">Fecha</th><th className="px-3 py-2.5 text-left">Artículo</th><th className="px-3 py-2.5 text-center">Cantidad</th><th className="px-3 py-2.5 text-right">Unitario</th><th className="px-3 py-2.5 text-right">Extras</th><th className="px-3 py-2.5 text-right">Total</th><th className="px-3 py-2.5 text-left">Proveedor</th><th className="px-3 py-2.5 text-center">Acción</th></tr></thead>
                <tbody>{data?.productCosts.map((item) => { const key = item.variant_id ? `v:${item.product_id}:${item.variant_id}` : `p:${item.product_id}`; const extras = Number(item.freight_cost) + Number(item.tax_cost) + Number(item.commission_cost) + Number(item.other_cost); return <tr key={item.id} className="border-t border-white/6 text-white/65"><td className="px-3 py-3">{item.purchase_date}</td><td className="px-3 py-3 font-bold text-white">{productNames.get(key) ?? `Producto #${item.product_id}`}</td><td className="px-3 py-3 text-center tabular-nums">{item.quantity}</td><td className="px-3 py-3 text-right tabular-nums">{formatPrice(Number(item.unit_cost))}</td><td className="px-3 py-3 text-right tabular-nums">{formatPrice(extras)}</td><td className="px-3 py-3 text-right font-black tabular-nums text-white">{formatPrice(Number(item.total_cost))}</td><td className="px-3 py-3">{item.supplier || "—"}</td><td className="px-3 py-3 text-center"><button type="button" aria-label="Eliminar compra" onClick={() => void remove("product", item.id)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/25 text-red-300 transition hover:bg-red-400/10"><Trash2 className="size-3.5" /></button></td></tr>})}</tbody>
              </table>
              {!data?.productCosts.length && <p className="px-4 py-8 text-center text-sm text-white/42">Todavía no registraste compras.</p>}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2"><Plus className="size-4 text-beyonix-sky" /><h3 className="text-base font-black text-white">Nuevo gasto</h3></div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Fecha gasto"><AdminDatePicker title="Fecha gasto" ariaLabel="Fecha del gasto" value={expenseDate} onChange={setExpenseDate} centered /></Field>
              <Field label="Categoría"><ModernSelect value={expenseCategory} onChange={setExpenseCategory} options={EXPENSE_CATEGORIES.map((category) => ({ value: category, label: category }))} /></Field>
              <Field label="Importe"><MoneyInput value={expenseAmount} onChange={setExpenseAmount} /></Field>
              <Field label="Estado"><ModernSelect value={expenseStatus} onChange={setExpenseStatus} options={[{ value: "pagado", label: "Pagado" }, { value: "pendiente", label: "Pendiente" }]} /></Field>
              <Field label="Frecuencia"><ModernSelect value={expenseRecurrence} onChange={setExpenseRecurrence} options={[{ value: "unico", label: "Único" }, { value: "mensual", label: "Mensual" }, { value: "bimestral", label: "Bimestral" }, { value: "trimestral", label: "Trimestral" }, { value: "semestral", label: "Semestral" }, { value: "anual", label: "Anual" }]} /></Field>
              <Field label="Descripción" className="xl:col-span-2"><input value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} className={inputClass} placeholder="Ej. cuota mensual" /></Field>
              <Field label="Proveedor"><input value={expenseSupplier} onChange={(event) => setExpenseSupplier(event.target.value)} className={inputClass} placeholder="ARCA, contador..." /></Field>
              <Field label="Medio pago"><input value={expensePaymentMethod} onChange={(event) => setExpensePaymentMethod(event.target.value)} className={inputClass} placeholder="Opcional" /></Field>
              <Field label="Comprobante"><input value={expenseDocumentType} onChange={(event) => setExpenseDocumentType(event.target.value)} className={inputClass} placeholder="Factura, recibo" /></Field>
              <Field label="Número"><input value={expenseDocumentNumber} onChange={(event) => setExpenseDocumentNumber(event.target.value)} className={inputClass} placeholder="Opcional" /></Field>
              <Field label="Notas" className="xl:col-span-3"><input value={expenseNotes} onChange={(event) => setExpenseNotes(event.target.value)} className={inputClass} placeholder="Detalle adicional" /></Field>
              <label className="flex h-10 cursor-pointer items-center justify-center gap-2 self-end rounded-xl border border-beyonix-blue-light/18 bg-[#07111B] px-3 text-xs font-black text-white/65"><input type="checkbox" checked={expenseTaxDeductible} onChange={(event) => setExpenseTaxDeductible(event.target.checked)} className="size-4 accent-blue-500" /> Computable fiscal</label>
            </div>
            <div className="mt-4 flex justify-end"><button type="button" disabled={saving} onClick={() => void saveExpense()} className="inline-flex h-10 min-w-130px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/35 bg-beyonix-blue/38 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/60 hover:bg-beyonix-blue/55 disabled:cursor-wait disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Guardar</button></div>
          </section>

          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-base font-black text-white">Historial de gastos</h3><span className="text-xs font-bold text-white/38">{data?.expenses.length ?? 0} registros</span></div>
            <div className="overflow-x-auto rounded-2xl border border-white/7">
              <table className="w-full min-w-1000px text-sm"><thead className="bg-black/30 text-10px uppercase tracking-widest text-white/42"><tr><th className="px-3 py-2.5 text-left">Fecha</th><th className="px-3 py-2.5 text-left">Categoría</th><th className="px-3 py-2.5 text-left">Descripción</th><th className="px-3 py-2.5 text-right">Importe</th><th className="px-3 py-2.5 text-center">Estado</th><th className="px-3 py-2.5 text-center">Frecuencia</th><th className="px-3 py-2.5 text-left">Proveedor</th><th className="px-3 py-2.5 text-center">Acción</th></tr></thead>
                <tbody>{data?.expenses.map((item) => <tr key={item.id} className="border-t border-white/6 text-white/65"><td className="px-3 py-3">{item.expense_date}</td><td className="px-3 py-3 font-bold text-white">{item.category}</td><td className="px-3 py-3">{item.description || "—"}</td><td className="px-3 py-3 text-right font-black tabular-nums text-white">{formatPrice(Number(item.amount))}</td><td className="px-3 py-3 text-center"><span className={`rounded-full border px-2.5 py-1 text-xs font-black ${item.status === "pagado" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>{item.status === "pagado" ? "Pagado" : "Pendiente"}</span></td><td className="px-3 py-3 text-center capitalize">{item.recurrence}</td><td className="px-3 py-3">{item.supplier || "—"}</td><td className="px-3 py-3 text-center"><button type="button" aria-label="Eliminar gasto" onClick={() => void remove("expense", item.id)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/25 text-red-300 transition hover:bg-red-400/10"><Trash2 className="size-3.5" /></button></td></tr>)}</tbody>
              </table>
              {!data?.expenses.length && <p className="px-4 py-8 text-center text-sm text-white/42">Todavía no registraste gastos.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
