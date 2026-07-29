"use client"

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  FileSpreadsheet,
  Link2,
  Minus,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Truck,
  Upload,
  X,
} from "lucide-react"

import {
  MERCADOLIBRE_FIELD_KEYS,
  parseMercadoLibreSalesReport,
  summarizeMercadoLibreRows,
  type MercadoLibreFieldMap,
  type MercadoLibreImportRow,
  type ParsedMercadoLibreReport,
} from "@/lib/mercadolibre/sales-report"
import {
  deleteMercadoLibreSale,
  getMercadoLibreSales,
  importMercadoLibreSales,
  saveMercadoLibreCostMapping,
  saveMercadoLibreReturnReview,
  type MercadoLibreCostCatalogProduct,
  type StoredMercadoLibreSale,
} from "@/lib/supabase/queries/mercadolibre-sales"
import { formatPrice } from "../productos/helpers"
import {
  AdminDangerButton,
  AdminModal,
  AdminSecondaryButton,
  AdminSelect,
} from "../../components/admin-controls"

function number(value: unknown) {
  const parsed = Number(
    typeof value === "string"
      ? value.replace(",", ".")
      : value ?? 0,
  )
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown) {
  return value == null ? "" : String(value).trim()
}

function isMercadoLibreReturn(row: StoredMercadoLibreSale) {
  const raw = row.raw_data as {
    parsed?: Record<string, unknown>
  }
  const parsed = raw.parsed ?? {}
  const status = text(parsed.status).toLocaleLowerCase("es")
  return (
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(parsed.cancellations_refunds) < 0 ||
    Boolean(text(parsed.return_delivered_date)) ||
    Boolean(text(parsed.return_tracking_number))
  )
}

function formatDate(value: string | null) {
  if (!value) return "Sin fecha"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

function emptyParsedFields() {
  return Object.fromEntries(
    MERCADOLIBRE_FIELD_KEYS.map((key) => [key, null]),
  ) as MercadoLibreFieldMap
}

function storedAsImportRow(row: StoredMercadoLibreSale): MercadoLibreImportRow {
  const raw = row.raw_data as Partial<MercadoLibreImportRow["raw_data"]>
  if (
    raw.report_format === "mercadolibre_ventas_ar" &&
    raw.parsed &&
    raw.grouped &&
    raw.source
  ) {
    return {
      sale_date: row.sale_date,
      operation_id: row.operation_id ?? "",
      order_id: row.order_id ?? row.operation_id ?? "",
      product_name: row.product_name,
      sku: row.sku,
      quantity: number(row.quantity),
      gross_amount: number(row.gross_amount),
      fee_amount: number(row.fee_amount),
      shipping_amount: number(row.shipping_amount),
      net_amount: number(row.net_amount),
      raw_data: raw as MercadoLibreImportRow["raw_data"],
    }
  }

  const parsed = emptyParsedFields()
  parsed.sale_number = row.operation_id
  parsed.sale_date_text = row.sale_date
  parsed.status = "Importación anterior"
  parsed.units = number(row.quantity)
  parsed.product_revenue = number(row.gross_amount)
  parsed.sale_fee = -number(row.fee_amount)
  parsed.shipping_cost = -number(row.shipping_amount)
  parsed.total = number(row.net_amount)
  parsed.sku = row.sku
  parsed.listing_title = row.product_name

  return {
    sale_date: row.sale_date,
    operation_id: row.operation_id ?? "",
    order_id: row.order_id ?? row.operation_id ?? "",
    product_name: row.product_name,
    sku: row.sku,
    quantity: number(row.quantity),
    gross_amount: number(row.gross_amount),
    fee_amount: number(row.fee_amount),
    shipping_amount: number(row.shipping_amount),
    net_amount: number(row.net_amount),
    raw_data: {
      report_format: "mercadolibre_ventas_ar",
      parsed,
      grouped: {
        "Datos disponibles": {
          Venta: row.operation_id,
          Fecha: row.sale_date,
          Producto: row.product_name,
          SKU: row.sku,
          Unidades: row.quantity,
          "Ingresos por productos": row.gross_amount,
          Cargos: row.fee_amount,
          "Costos de envío": row.shipping_amount,
          Total: row.net_amount,
        },
      },
      source: {
        sheet: "Importación anterior",
        row_number: 0,
        groups: [],
        headers: [],
        cells: [],
      },
    },
  }
}

function SummaryCard({
  label,
  value,
  helper,
  icon,
  tone = "neutral",
}: {
  label: string
  value: string
  helper: string
  icon: React.ReactNode
  tone?: "neutral" | "positive" | "warning" | "danger"
}) {
  const valueClass = {
    neutral: "text-white",
    positive: "text-emerald-300",
    warning: "text-amber-200",
    danger: "text-red-300",
  }[tone]
  return (
    <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/25 px-3 py-2.5 text-center">
      <span className="mx-auto flex size-6 items-center justify-center rounded-md bg-beyonix-blue/20 text-beyonix-sky">
        {icon}
      </span>
      <p className="mt-1.5 text-9px font-black uppercase tracking-widest text-white/40">
        {label}
      </p>
      <p className={`mt-0.5 text-base font-black tabular-nums ${valueClass}`}>{value}</p>
      <p
        title={helper}
        className="mt-0.5 truncate text-10px font-semibold text-white/35"
      >
        {helper}
      </p>
    </div>
  )
}

function DetailValue({ value }: { value: unknown }) {
  const display = text(value)
  return (
    <span className={display ? "text-white/70" : "text-white/24"}>
      {display || "Sin dato"}
    </span>
  )
}

const reviewInputClass =
  "h-10 w-full rounded-xl border border-beyonix-blue-light/18 bg-[#07111B] px-3 text-center text-sm font-black text-white outline-none transition focus:border-beyonix-sky/55"

function clampQuantity(value: unknown, min: number, max: number) {
  const parsed = Math.trunc(number(value))
  return Math.min(Math.max(parsed, min), Math.max(min, max))
}

function ReturnQuantityStepper({
  label,
  value,
  min = 0,
  max,
  tone,
  onChange,
}: {
  label: string
  value: string
  min?: number
  max: number
  tone: "blue" | "green" | "amber" | "red"
  onChange: (value: string) => void
}) {
  const quantity = clampQuantity(value, min, max)
  const inputId = `return-${label.toLocaleLowerCase("es").replace(/\s+/g, "-")}`
  const toneStyles = {
    blue: {
      card: "border-sky-400/20 bg-sky-400/[0.055]",
      label: "text-sky-200/75",
      button: "text-sky-300 hover:bg-sky-400/12",
    },
    green: {
      card: "border-emerald-400/20 bg-emerald-400/[0.055]",
      label: "text-emerald-200/75",
      button: "text-emerald-300 hover:bg-emerald-400/12",
    },
    amber: {
      card: "border-amber-300/20 bg-amber-300/[0.055]",
      label: "text-amber-100/75",
      button: "text-amber-200 hover:bg-amber-300/12",
    },
    red: {
      card: "border-red-400/20 bg-red-400/[0.055]",
      label: "text-red-200/75",
      button: "text-red-300 hover:bg-red-400/12",
    },
  }[tone]
  const commit = (nextValue: unknown) => {
    onChange(String(clampQuantity(nextValue, min, max)))
  }

  return (
    <div className={`rounded-xl border p-2.5 ${toneStyles.card}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className={`truncate text-10px font-black uppercase tracking-wider ${toneStyles.label}`}
        >
          {label}
        </label>
        <span className="shrink-0 rounded-md border border-white/8 bg-black/25 px-1.5 py-0.5 text-9px font-bold tabular-nums text-white/42">
          Límite {max}
        </span>
      </div>
      <div className="grid h-11 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] overflow-hidden rounded-lg border border-white/10 bg-[#050B12] shadow-inner transition focus-within:border-beyonix-sky/55">
        <button
          type="button"
          aria-label={`Restar una unidad en ${label}`}
          disabled={quantity <= min}
          onClick={() => commit(quantity - 1)}
          className={`flex cursor-pointer items-center justify-center border-r border-white/8 transition disabled:cursor-not-allowed disabled:text-white/18 ${toneStyles.button}`}
        >
          <Minus className="size-4" />
        </button>
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          role="spinbutton"
          value={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={quantity}
          onChange={(event) => commit(event.target.value.replace(/\D/g, ""))}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault()
              commit(quantity + 1)
            }
            if (event.key === "ArrowDown") {
              event.preventDefault()
              commit(quantity - 1)
            }
          }}
          className="min-w-0 bg-transparent px-1 text-center text-base font-black tabular-nums text-white outline-none"
        />
        <button
          type="button"
          aria-label={`Sumar una unidad en ${label}`}
          disabled={quantity >= max}
          onClick={() => commit(quantity + 1)}
          className={`flex cursor-pointer items-center justify-center border-l border-white/8 transition disabled:cursor-not-allowed disabled:text-white/18 ${toneStyles.button}`}
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  )
}

export function AdminMercadoLibreSales() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [sales, setSales] = useState<StoredMercadoLibreSale[]>([])
  const [catalog, setCatalog] = useState<MercadoLibreCostCatalogProduct[]>([])
  const [preview, setPreview] = useState<ParsedMercadoLibreReport | null>(null)
  const [fileName, setFileName] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [savingMappingKey, setSavingMappingKey] = useState<string | null>(null)
  const [mappingEditorKey, setMappingEditorKey] = useState<string | null>(null)
  const [reviewingReturn, setReviewingReturn] =
    useState<StoredMercadoLibreSale | null>(null)
  const [savingReturnReview, setSavingReturnReview] = useState(false)
  const [receivedReturnQuantity, setReceivedReturnQuantity] = useState("0")
  const [sellableReturnQuantity, setSellableReturnQuantity] = useState("0")
  const [discountedReturnQuantity, setDiscountedReturnQuantity] = useState("0")
  const [nonSellableReturnQuantity, setNonSellableReturnQuantity] =
    useState("0")
  const [returnDiscountPercent, setReturnDiscountPercent] = useState("")
  const [returnDiscountReason, setReturnDiscountReason] = useState("")
  const [returnNonSellableReason, setReturnNonSellableReason] = useState("")
  const [returnReviewNotes, setReturnReviewNotes] = useState("")
  const [pendingDelete, setPendingDelete] =
    useState<StoredMercadoLibreSale | null>(null)
  const [error, setError] = useState("")
  const [costingError, setCostingError] = useState("")
  const [success, setSuccess] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const data = await getMercadoLibreSales()
      setSales(data.rows)
      setCatalog(data.catalog)
      setCostingError(data.costingError ?? "")
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No se pudieron cargar las ventas de Mercado Libre.",
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const importedRows = useMemo(() => sales.map(storedAsImportRow), [sales])
  const summary = useMemo(
    () => summarizeMercadoLibreRows(importedRows),
    [importedRows],
  )
  const costSummary = useMemo(() => {
    const totalCostableUnits = sales.reduce(
      (total, row) => total + number(row.costing?.costable_units),
      0,
    )
    const coveredUnits = sales.reduce(
      (total, row) =>
        total +
        (row.costing?.merchandise_cost == null
          ? 0
          : number(row.costing.costable_units)),
      0,
    )
    const merchandiseCost = sales.reduce(
      (total, row) => total + number(row.costing?.merchandise_cost),
      0,
    )
    const exact =
      !costingError &&
      sales.every(
        (row) =>
          number(row.costing?.costable_units) === 0 ||
          row.costing?.merchandise_cost != null,
      )

    return {
      totalCostableUnits,
      coveredUnits,
      merchandiseCost,
      exact,
      profit: exact ? summary.total - merchandiseCost : null,
    }
  }, [costingError, sales, summary.total])
  const mappingGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string
        sku: string | null
        productName: string
        productId: number | null
        variantId: number | null
        standaloneKey: string | null
        costableUnits: number
        coveredUnits: number
        sales: number
      }
    >()

    sales.forEach((row) => {
      const key =
        row.costing?.match_key ??
        (row.sku ? `sku:${row.sku}` : `product:${row.product_name}`)
      const current = groups.get(key) ?? {
        key,
        sku: row.sku,
        productName: row.product_name,
        productId: row.costing?.product_id ?? null,
        variantId: row.costing?.variant_id ?? null,
        standaloneKey: row.costing?.standalone_key ?? null,
        costableUnits: 0,
        coveredUnits: 0,
        sales: 0,
      }
      current.costableUnits += number(row.costing?.costable_units)
      current.coveredUnits +=
        row.costing?.merchandise_cost == null
          ? 0
          : number(row.costing?.costable_units)
      current.sales += 1
      groups.set(key, current)
    })

    return [...groups.values()].sort((a, b) =>
      (a.sku ?? a.productName).localeCompare(b.sku ?? b.productName, "es"),
    )
  }, [sales])
  const mappingOptions = useMemo(
    () =>
      catalog.flatMap((product) => [
        ...(
          product.standalone_key ||
          !product.producto_variantes?.length
            ? [{
                value: product.standalone_key
                  ? `c:${product.standalone_key}`
                  : `p:${product.id}`,
                label: product.nombre,
                sku: product.sku ?? null,
                searchText: `${product.nombre} ${product.sku ?? ""}`,
              }]
            : []
        ),
        ...(!product.standalone_key ? product.producto_variantes ?? [] : []).map((variant) => ({
          value: `v:${product.id}:${variant.id}`,
          label: `${product.nombre} · ${variant.nombre}`,
          sku: variant.sku ?? null,
          searchText: `${product.nombre} ${variant.nombre} ${variant.sku ?? ""}`,
        })),
      ]),
    [catalog],
  )
  const pendingMappingGroups = useMemo(
    () =>
      mappingGroups.filter(
        (group) => !group.productId && !group.standaloneKey,
      ),
    [mappingGroups],
  )

  const updateCostMapping = async (matchKey: string, value: string) => {
    const [kind, productText, variantText] = value.split(":")
    const productId = kind === "p" || kind === "v" ? Number(productText) : null
    const variantId = kind === "v" ? Number(variantText) : null
    const standaloneKey = kind === "c" ? value.slice(2) : null

    setSavingMappingKey(matchKey)
    setError("")
    setSuccess("")
    try {
      await saveMercadoLibreCostMapping(
        matchKey,
        productId,
        variantId,
        standaloneKey,
      )
      await load()
      setMappingEditorKey(null)
      setSuccess(
        productId
          ? "Publicación vinculada al producto, su costo y el inventario."
          : standaloneKey
            ? "Publicación vinculada al costo histórico. No afecta el inventario porque no pertenece al catálogo."
          : "Vinculación de costos eliminada.",
      )
    } catch (mappingError) {
      setError(
        mappingError instanceof Error
          ? mappingError.message
          : "No se pudo guardar la vinculación.",
      )
    } finally {
      setSavingMappingKey(null)
    }
  }

  const openReturnReview = (sale: StoredMercadoLibreSale) => {
    const review = sale.return_review
    setReviewingReturn(sale)
    setReceivedReturnQuantity(
      String(review?.received_quantity ?? sale.quantity),
    )
    setSellableReturnQuantity(
      String(review?.sellable_quantity ?? 0),
    )
    setDiscountedReturnQuantity(
      String(review?.discounted_quantity ?? 0),
    )
    setNonSellableReturnQuantity(
      String(review?.non_sellable_quantity ?? 0),
    )
    setReturnDiscountPercent(
      review?.discount_percent == null
        ? ""
        : String(review.discount_percent),
    )
    setReturnDiscountReason(review?.discount_reason ?? "")
    setReturnNonSellableReason(review?.non_sellable_reason ?? "")
    setReturnReviewNotes(review?.review_notes ?? "")
    setError("")
  }

  const saveReturnReview = async () => {
    if (!reviewingReturn) return
    try {
      setSavingReturnReview(true)
      setError("")
      await saveMercadoLibreReturnReview(reviewingReturn.id, {
        receivedQuantity: number(receivedReturnQuantity),
        sellableQuantity: number(sellableReturnQuantity),
        discountedQuantity: number(discountedReturnQuantity),
        nonSellableQuantity: number(nonSellableReturnQuantity),
        discountPercent: returnDiscountPercent
          ? number(returnDiscountPercent)
          : null,
        discountReason: returnDiscountReason,
        nonSellableReason: returnNonSellableReason,
        notes: returnReviewNotes,
      })
      setReviewingReturn(null)
      setSuccess("Revisión física guardada y stock actualizado.")
      await load()
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : "No se pudo guardar la revisión física.",
      )
    } finally {
      setSavingReturnReview(false)
    }
  }

  const handleFile = async (file: File) => {
    setReading(true)
    setError("")
    setSuccess("")
    setPreview(null)
    setFileName(file.name)
    try {
      setPreview(parseMercadoLibreSalesReport(await file.arrayBuffer()))
    } catch (readError) {
      setError(
        readError instanceof Error
          ? readError.message
          : "No se pudo leer el reporte de Mercado Libre.",
      )
    } finally {
      setReading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  const confirmImport = async () => {
    if (!preview) return
    setImporting(true)
    setError("")
    setSuccess("")
    try {
      const response = await importMercadoLibreSales(preview.rows, fileName)
      const replaced = number(response?.replaced)
      const linked = number(response?.linked)
      setSuccess(
        `${preview.rows.length} movimientos importados${
          replaced ? `; ${replaced} registros anteriores reemplazados` : ""
        }${linked ? `; ${linked} vinculados al inventario` : ""}.`,
      )
      setPreview(null)
      setFileName("")
      await load()
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "No se pudo importar el reporte.",
      )
    } finally {
      setImporting(false)
    }
  }

  const remove = async (row: StoredMercadoLibreSale) => {
    setDeletingId(row.id)
    setError("")
    try {
      await deleteMercadoLibreSale(row.id)
      setSales((current) => current.filter((item) => item.id !== row.id))
      setSuccess(
        `Venta #${row.operation_id ?? row.id} eliminada. Podés recuperarla cargando nuevamente el Excel.`,
      )
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "No se pudo eliminar la venta.",
      )
    } finally {
      setDeletingId(null)
      setPendingDelete(null)
    }
  }

  const visibleRows = importedRows.map((row, index) => ({
    stored: sales[index],
    imported: row,
  }))
  const receivedReturn = number(receivedReturnQuantity)
  const classifiedReturn =
    number(sellableReturnQuantity) +
    number(discountedReturnQuantity) +
    number(nonSellableReturnQuantity)
  const pendingReturn = Math.max(
    0,
    receivedReturn - classifiedReturn,
  )
  const soldReturnQuantity = Math.max(
    0,
    Math.trunc(number(reviewingReturn?.quantity)),
  )
  const sellableReturnMax = Math.max(
    0,
    receivedReturn -
      number(discountedReturnQuantity) -
      number(nonSellableReturnQuantity),
  )
  const discountedReturnMax = Math.max(
    0,
    receivedReturn -
      number(sellableReturnQuantity) -
      number(nonSellableReturnQuantity),
  )
  const nonSellableReturnMax = Math.max(
    0,
    receivedReturn -
      number(sellableReturnQuantity) -
      number(discountedReturnQuantity),
  )
  const returnReviewValid =
    receivedReturn >= 0 &&
    receivedReturn <= number(reviewingReturn?.quantity) &&
    classifiedReturn <= receivedReturn &&
    (
      number(discountedReturnQuantity) === 0 ||
      (
        number(returnDiscountPercent) > 0 &&
        number(returnDiscountPercent) < 100 &&
        Boolean(returnDiscountReason.trim())
      )
    ) &&
    (
      number(nonSellableReturnQuantity) === 0 ||
      Boolean(returnNonSellableReason.trim())
    )

  return (
    <div className="admin-dashboard-panel admin-mercadolibre-sales space-y-3">
      <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[linear-gradient(145deg,rgba(7,16,24,0.9),rgba(3,7,13,0.98))] p-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              Reportes de Mercado Libre
            </p>
            <h2 className="mt-1 text-xl font-black text-white">Ventas ML</h2>
            <p className="mt-1 text-sm leading-5 text-white/55">
              Importá el Excel “Ventas AR” y conciliá ventas, cargos, envíos,
              devoluciones y reclamos. Sólo las unidades efectivas vinculadas
              a un producto descuentan stock.
            </p>
          </div>
          <div>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={reading || importing}
              className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/32 bg-beyonix-blue/35 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/65 hover:bg-beyonix-blue/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {reading ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="size-4 text-beyonix-sky" />
              )}
              Cargar Excel de Mercado Libre
            </button>
          </div>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-2 xl:grid-cols-4">
          <SummaryCard
            label="Ventas"
            value={String(summary.sales)}
            helper={`${summary.completedSales} efectivas · ${summary.returnSales} devueltas · ${summary.cancelledSales} canceladas`}
            icon={<CheckCircle2 className="size-4" />}
          />
          <SummaryCard
            label="Unidades vendidas"
            value={String(summary.units)}
            helper={`${summary.returnedUnits} devueltas · ${summary.netUnits} netas`}
            icon={<Package className="size-4" />}
          />
          <SummaryCard
            label="Ingresos por productos"
            value={formatPrice(summary.productRevenue)}
            helper="Bruto antes de cargos y reembolsos"
            icon={<CircleDollarSign className="size-4" />}
          />
          <SummaryCard
            label="Ganancia obtenida"
            value={
              costSummary.profit == null
                ? "Pendiente"
                : formatPrice(costSummary.profit)
            }
            helper={
              costSummary.profit == null
                ? `${costSummary.coveredUnits}/${costSummary.totalCostableUnits} unidades con costo`
                : `ML ${formatPrice(summary.total)} − mercadería ${formatPrice(costSummary.merchandiseCost)}`
            }
            icon={<CircleDollarSign className="size-4" />}
            tone={
              costSummary.profit == null
                ? "warning"
                : costSummary.profit >= 0
                  ? "positive"
                  : "danger"
            }
          />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4 2xl:grid-cols-8">
          <SummaryCard label="Cargos por venta" value={formatPrice(Math.abs(summary.saleFees))} helper={`Suma aplicada en ${summary.salesWithSaleFee} operaciones`} icon={<CircleDollarSign className="size-3.5" />} tone="warning" />
          <SummaryCard label="Costo fijo" value={formatPrice(Math.abs(summary.fixedCosts))} helper="Cargos fijos" icon={<CircleDollarSign className="size-3.5" />} tone="warning" />
          <SummaryCard label="Costo por cuotas" value={formatPrice(Math.abs(summary.installmentCosts))} helper="Financiación" icon={<CircleDollarSign className="size-3.5" />} tone="warning" />
          <SummaryCard label="Envío acreditado por ML" value={formatPrice(summary.shippingIncome)} helper={`${formatPrice(summary.shippingIncomeOnEffectiveSales)} en ventas · ${formatPrice(summary.shippingIncomeOnReturns)} en devoluciones`} icon={<Truck className="size-3.5" />} />
          <SummaryCard label="Envío descontado por ML" value={formatPrice(Math.abs(summary.shippingCosts + summary.declaredShippingCosts))} helper="Costo logístico total descontado" icon={<Truck className="size-3.5" />} tone="warning" />
          <SummaryCard label="Reembolsos" value={formatPrice(Math.abs(summary.cancellationsRefunds))} helper={`${summary.returnSales} devoluciones`} icon={<RotateCcw className="size-3.5" />} tone={summary.returnSales ? "danger" : "neutral"} />
          <SummaryCard label="Envío descontado en devoluciones" value={formatPrice(summary.returnShippingCosts)} helper="Ya incluido arriba; no es un cargo adicional" icon={<RotateCcw className="size-3.5" />} tone={summary.returnShippingCosts ? "danger" : "neutral"} />
          <SummaryCard label="Reclamos" value={String(summary.claims)} helper="Con unidades o mediación" icon={<AlertTriangle className="size-3.5" />} tone={summary.claims ? "warning" : "neutral"} />
        </div>
      </section>

      {pendingMappingGroups.length > 0 && (
        <section className="rounded-2xl border border-amber-300/18 bg-amber-300/5 p-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-amber-300/20 bg-amber-300/8 text-amber-200">
              <Link2 className="size-4" />
            </span>
            <h3 className="text-sm font-black text-white">
              {pendingMappingGroups.length} SKU sin vincular
            </h3>
          </div>

          {costingError && (
            <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs text-amber-100">
              {costingError}
            </p>
          )}

          <div className="mt-2 grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
            {pendingMappingGroups.map((group) => {
              const editing = mappingEditorKey === group.key
              return (
                <div
                  key={group.key}
                  className="flex min-w-0 flex-col items-stretch gap-2 rounded-xl border border-white/8 bg-black/20 p-2.5 sm:flex-row sm:items-center sm:pl-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black text-white">
                      {group.sku ? `SKU ${group.sku}` : "Sin SKU"}
                    </p>
                    <p
                      title={group.productName}
                      className="mt-1 truncate text-11px text-white/42"
                    >
                      {group.productName}
                    </p>
                  </div>
                  <div className="w-full shrink-0 sm:ml-auto sm:w-56">
                    {editing ? (
                      <AdminSelect
                        title="Producto asociado"
                        ariaLabel={`Producto asociado a ${group.sku ?? group.productName}`}
                        value=""
                        disabled={savingMappingKey === group.key}
                        centered
                        searchable
                        searchPlaceholder="Buscar por nombre o SKU..."
                        onChange={(value) =>
                          void updateCostMapping(group.key, value)
                        }
                      >
                        <option value="">Elegir producto</option>
                        {mappingOptions.map((option) => (
                          <option
                            key={option.value}
                            value={option.value}
                            data-search={option.searchText}
                            data-meta={option.sku ?? undefined}
                            data-selected-label={option.label}
                          >
                            {option.label}
                          </option>
                        ))}
                      </AdminSelect>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMappingEditorKey(group.key)}
                        className="inline-flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-beyonix-sky/28 bg-beyonix-blue/24 px-3 text-xs font-black text-beyonix-sky transition hover:border-beyonix-sky/55 hover:bg-beyonix-blue/42"
                      >
                        <Link2 className="size-3.5" />
                        Vincular producto
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {error && (
        <p className="rounded-2xl border border-red-400/22 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-2xl border border-emerald-400/22 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
          {success}
        </p>
      )}

      {preview && (
        <section className="rounded-2xl border border-beyonix-sky/28 bg-[#071018] p-3.5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
                Previsualización
              </p>
              <h3 className="mt-1 text-lg font-black text-white">{fileName}</h3>
              <p className="mt-1 text-xs text-white/48">
                Hoja “{preview.sheetName}” · {preview.rows.length} movimientos ·{" "}
                {preview.summary.units} unidades
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreview(null)
                  setFileName("")
                }}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-4 text-xs font-black text-white/60 transition hover:border-white/25 hover:text-white"
              >
                <X className="size-3.5" />
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmImport()}
                disabled={importing}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/14 px-4 text-xs font-black text-emerald-200 transition hover:bg-emerald-400/24 disabled:opacity-50"
              >
                {importing ? (
                  <RefreshCw className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                Confirmar importación
              </button>
            </div>
          </div>

          <p className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/7 px-3 py-2 text-center text-xs font-bold text-amber-100">
            Esta previsualización todavía no modifica el inventario. Presioná
            “Confirmar importación” para registrar y descontar las ventas
            vinculadas.
          </p>

          {preview.warnings.length > 0 && (
            <div className="mt-3 space-y-1 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs text-amber-100">
              {preview.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}

          <div className="sales-ledger-scrollbar mt-4 overflow-x-auto rounded-2xl border border-white/8">
            <table className="min-w-[1250px] w-full text-center text-xs">
              <thead className="bg-beyonix-blue/18 text-9px font-black uppercase tracking-widest text-white/42">
                <tr>
                  {["Venta", "Fecha", "Estado", "Producto", "Unidades", "Ingreso productos", "Cargos", "Envío descontado", "Reembolsos", "Total"].map((label) => (
                    <th key={label} className="px-3 py-3">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 25).map((row, index) => {
                  const fields = row.raw_data.parsed
                  return (
                    <tr key={`${row.operation_id}-${row.sku}-${index}`} className="border-t border-white/6 text-white/65">
                      <td className="px-3 py-3 font-bold text-white">{row.operation_id}</td>
                      <td className="px-3 py-3">{text(fields.sale_date_text)}</td>
                      <td className="max-w-56 px-3 py-3"><span className="block truncate" title={text(fields.status)}>{text(fields.status)}</span></td>
                      <td className="max-w-72 px-3 py-3"><span className="block truncate" title={row.product_name}>{row.product_name}</span></td>
                      <td className="px-3 py-3">{row.quantity}</td>
                      <td className="px-3 py-3 tabular-nums">{formatPrice(row.gross_amount)}</td>
                      <td className="px-3 py-3 tabular-nums text-amber-200">{formatPrice(Math.abs(row.fee_amount))}</td>
                      <td className="px-3 py-3 tabular-nums text-amber-200">{formatPrice(Math.abs(number(fields.shipping_cost) + number(fields.declared_shipping_cost)))}</td>
                      <td className="px-3 py-3 tabular-nums text-red-300">{formatPrice(Math.abs(number(fields.cancellations_refunds)))}</td>
                      <td className={`px-3 py-3 font-black tabular-nums ${row.net_amount >= 0 ? "text-emerald-300" : "text-red-300"}`}>{formatPrice(row.net_amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 25 && (
            <p className="mt-2 text-center text-11px text-white/35">
              Se muestran 25 filas de {preview.rows.length}. Todas serán importadas.
            </p>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[#071018] p-3.5">
        <div className="mb-4">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Movimientos importados
          </p>
          <h3 className="mt-1 text-lg font-black text-white">Detalle completo</h3>
          <p className="mt-1 text-xs text-white/42">
            Abrí una fila para consultar los 65 campos originales del reporte.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-white/45">
            <RefreshCw className="size-4 animate-spin" />
            Cargando ventas...
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="py-12 text-center">
            <FileSpreadsheet className="mx-auto size-8 text-white/20" />
            <p className="mt-3 text-sm font-bold text-white/48">
              Todavía no importaste un reporte de Mercado Libre.
            </p>
          </div>
        ) : (
          <div className="sales-ledger-scrollbar overflow-x-auto rounded-2xl border border-white/8">
            <table className="min-w-[1720px] w-full text-center text-xs">
              <thead className="bg-beyonix-blue/18 text-9px font-black uppercase tracking-widest text-white/42">
                <tr>
                  {["Venta", "Fecha", "Estado", "Producto / SKU", "Unidades", "Ingreso productos", "Cargos ML", "Envío descontado", "Reembolsos", "Total ML", "Costo mercadería", "Ganancia", "Comprador", "Acciones"].map((label) => (
                    <th key={label} className="px-3 py-3">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(({ stored, imported }) => {
                  const fields = imported.raw_data.parsed
                  const expanded = expandedId === stored.id
                  const merchandiseCost = stored.costing?.merchandise_cost
                  const rowProfit =
                    merchandiseCost == null
                      ? null
                      : imported.net_amount - merchandiseCost
                  return (
                    <Fragment key={stored.id}>
                      <tr className="border-t border-white/6 text-white/65 transition hover:bg-beyonix-blue/8">
                        <td className="px-3 py-3 font-black text-white">{imported.operation_id}</td>
                        <td className="px-3 py-3">{formatDate(imported.sale_date)}</td>
                        <td className="max-w-56 px-3 py-3">
                          <span className="block truncate" title={text(fields.status)}>{text(fields.status) || "Sin estado"}</span>
                          {stored.return_review && (
                            <span className="mt-1 block text-9px font-bold text-emerald-300">
                              {stored.return_review.sellable_quantity + stored.return_review.discounted_quantity} reingresan
                              {" · "}
                              {stored.return_review.received_quantity
                                - stored.return_review.sellable_quantity
                                - stored.return_review.discounted_quantity
                                - stored.return_review.non_sellable_quantity} pendientes
                            </span>
                          )}
                        </td>
                        <td className="max-w-80 px-3 py-3">
                          <span className="block truncate font-bold text-white" title={imported.product_name}>{imported.product_name}</span>
                          <span className="mt-1 block text-10px font-bold text-beyonix-sky">
                            {stored.costing?.catalog_sku ?? imported.sku ?? "Sin SKU"}
                          </span>
                          {stored.costing?.catalog_sku &&
                            imported.sku &&
                            stored.costing.catalog_sku !== imported.sku && (
                              <span className="mt-0.5 block text-9px text-white/32">
                                SKU original de ML: {imported.sku}
                              </span>
                            )}
                        </td>
                        <td className="px-3 py-3">{imported.quantity}</td>
                        <td className="px-3 py-3 tabular-nums">{formatPrice(imported.gross_amount)}</td>
                        <td className="px-3 py-3 tabular-nums text-amber-200">{formatPrice(Math.abs(imported.fee_amount))}</td>
                        <td className="px-3 py-3 tabular-nums text-amber-200">{formatPrice(Math.abs(number(fields.shipping_cost) + number(fields.declared_shipping_cost)))}</td>
                        <td className="px-3 py-3 tabular-nums text-red-300">{formatPrice(Math.abs(number(fields.cancellations_refunds)))}</td>
                        <td className={`px-3 py-3 font-black tabular-nums ${imported.net_amount >= 0 ? "text-emerald-300" : "text-red-300"}`}>{formatPrice(imported.net_amount)}</td>
                        <td className={`px-3 py-3 tabular-nums ${merchandiseCost == null ? "text-amber-200" : "text-white/65"}`}>
                          {merchandiseCost == null ? "Pendiente" : formatPrice(merchandiseCost)}
                        </td>
                        <td className={`px-3 py-3 font-black tabular-nums ${rowProfit == null ? "text-amber-200" : rowProfit >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                          {rowProfit == null ? "Pendiente" : formatPrice(rowProfit)}
                        </td>
                        <td className="max-w-48 px-3 py-3"><span className="block truncate" title={text(fields.buyer)}>{text(fields.buyer) || "Sin dato"}</span></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1.5">
                            {isMercadoLibreReturn(stored) && (
                              <button
                                type="button"
                                aria-label="Revisar devolución"
                                title={
                                  stored.return_review
                                    ? "Editar revisión física"
                                    : "Revisar devolución"
                                }
                                onClick={() => openReturnReview(stored)}
                                className={`flex size-8 cursor-pointer items-center justify-center rounded-lg border transition ${
                                  stored.return_review
                                    ? "border-emerald-400/28 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/18"
                                    : "border-amber-300/28 bg-amber-300/8 text-amber-200 hover:bg-amber-300/16"
                                }`}
                              >
                                <RotateCcw className="size-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={expanded ? "Cerrar detalle" : "Ver detalle"}
                              title={expanded ? "Cerrar detalle" : "Ver los 65 campos"}
                              onClick={() => setExpandedId(expanded ? null : stored.id)}
                              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-beyonix-sky/24 bg-beyonix-blue/20 text-beyonix-sky transition hover:border-beyonix-sky/55 hover:bg-beyonix-blue/45"
                            >
                              <ChevronDown className={`size-3.5 transition ${expanded ? "rotate-180" : ""}`} />
                            </button>
                            <button
                              type="button"
                              aria-label="Eliminar venta"
                              title="Eliminar"
                              onClick={() => setPendingDelete(stored)}
                              disabled={deletingId === stored.id}
                              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-red-400/20 bg-red-400/8 text-red-300 transition hover:border-red-400/45 hover:bg-red-400/16 disabled:opacity-50"
                            >
                              {deletingId === stored.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-t border-beyonix-sky/18 bg-black/28">
                          <td colSpan={14} className="p-4 text-left">
                            <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
                              {Object.entries(imported.raw_data.grouped).map(([group, values]) => (
                                <div key={group} className="rounded-2xl border border-beyonix-blue-light/14 bg-[#07111B] p-3">
                                  <p className="mb-2 text-10px font-black uppercase tracking-widest text-beyonix-cyan">{group}</p>
                                  <div className="space-y-1.5">
                                    {Object.entries(values).map(([label, value]) => (
                                      <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3 border-t border-white/5 pt-1.5 text-11px first:border-0 first:pt-0">
                                        <span className="text-white/38">{label}</span>
                                        <span className="min-w-0 break-words text-right"><DetailValue value={value} /></span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AdminModal
        open={Boolean(reviewingReturn)}
        eyebrow="Inventario ML"
        title="Revisión física de la devolución"
        description={
          reviewingReturn
            ? `${reviewingReturn.product_name} · ${reviewingReturn.quantity} unidades vendidas`
            : undefined
        }
        onClose={() => {
          if (!savingReturnReview) setReviewingReturn(null)
        }}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AdminSecondaryButton
              title="Cancelar revisión"
              aria-label="Cancelar revisión"
              disabled={savingReturnReview}
              onClick={() => setReviewingReturn(null)}
            >
              Cancelar
            </AdminSecondaryButton>
            <button
              type="button"
              disabled={!returnReviewValid || savingReturnReview}
              onClick={() => void saveReturnReview()}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/14 px-4 text-sm font-black text-emerald-200 transition hover:bg-emerald-400/24 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {savingReturnReview ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              Guardar revisión
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <section className="rounded-2xl border border-beyonix-blue-light/16 bg-black/20 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-black text-white">
                  Distribución de unidades
                </p>
                <p className="mt-0.5 text-10px font-semibold text-white/38">
                  Clasificá únicamente las unidades recibidas.
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/15 px-2.5 py-1 text-10px font-black tabular-nums text-beyonix-cyan">
                {classifiedReturn}/{receivedReturn} asignadas
              </span>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2">
              {[
                {
                  label: "Recibidas",
                  value: receivedReturnQuantity,
                  setter: setReceivedReturnQuantity,
                  min: classifiedReturn,
                  max: soldReturnQuantity,
                  tone: "blue" as const,
                },
                {
                  label: "Vendibles",
                  value: sellableReturnQuantity,
                  setter: setSellableReturnQuantity,
                  min: 0,
                  max: sellableReturnMax,
                  tone: "green" as const,
                },
                {
                  label: "Con descuento",
                  value: discountedReturnQuantity,
                  setter: setDiscountedReturnQuantity,
                  min: 0,
                  max: discountedReturnMax,
                  tone: "amber" as const,
                },
                {
                  label: "No vendibles",
                  value: nonSellableReturnQuantity,
                  setter: setNonSellableReturnQuantity,
                  min: 0,
                  max: nonSellableReturnMax,
                  tone: "red" as const,
                },
              ].map((field) => (
                <ReturnQuantityStepper
                  key={field.label}
                  label={field.label}
                  value={field.value}
                  min={field.min}
                  max={field.max}
                  tone={field.tone}
                  onChange={field.setter}
                />
              ))}
            </div>
          </section>

          {number(discountedReturnQuantity) > 0 && (
            <div className="rounded-xl border border-amber-300/16 bg-amber-300/[0.045] p-3">
              <p className="mb-2 text-10px font-black uppercase tracking-wider text-amber-100/70">
                Condición con descuento
              </p>
              <div className="grid gap-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <label>
                  <span className="mb-1.5 block text-10px font-bold text-white/45">
                    Descuento
                  </span>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={returnDiscountPercent}
                      onChange={(event) =>
                        setReturnDiscountPercent(
                          event.target.value.replace(/[^\d.,]/g, ""),
                        )
                      }
                      className={`${reviewInputClass} pr-9`}
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-black text-amber-200">
                      %
                    </span>
                  </div>
                </label>
                <label>
                  <span className="mb-1.5 block text-10px font-bold text-white/45">
                    Motivo obligatorio
                  </span>
                  <input
                    type="text"
                    value={returnDiscountReason}
                    maxLength={300}
                    onChange={(event) =>
                      setReturnDiscountReason(event.target.value)
                    }
                    placeholder="Ej.: Tiene una marca"
                    className={`${reviewInputClass} text-left font-semibold`}
                  />
                </label>
              </div>
            </div>
          )}

          {number(nonSellableReturnQuantity) > 0 && (
            <label className="block rounded-xl border border-red-400/16 bg-red-400/[0.045] p-3">
              <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-red-200/70">
                Motivo de no vendible · obligatorio
              </span>
              <input
                type="text"
                value={returnNonSellableReason}
                maxLength={300}
                onChange={(event) =>
                  setReturnNonSellableReason(event.target.value)
                }
                placeholder="Ej.: Llegó completamente roto"
                className={`${reviewInputClass} text-left font-semibold`}
              />
            </label>
          )}

          <label className="block">
            <span className="mb-2 block text-10px font-black uppercase tracking-wider text-white/45">
              Observaciones
            </span>
            <textarea
              value={returnReviewNotes}
              onChange={(event) => setReturnReviewNotes(event.target.value)}
              rows={2}
              placeholder="Estado físico, falla o decisión pendiente"
              className={`${reviewInputClass} h-auto min-h-20 resize-y py-2.5 text-left font-semibold`}
            />
          </label>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-emerald-400/18 bg-emerald-400/7 p-3 text-center">
              <p className="text-10px font-black uppercase tracking-wider text-emerald-200/65">
                Suman al stock
              </p>
              <p className="mt-1 text-xl font-black text-emerald-300">
                {number(sellableReturnQuantity) +
                  number(discountedReturnQuantity)}
              </p>
            </div>
            <div className="rounded-xl border border-red-400/18 bg-red-400/7 p-3 text-center">
              <p className="text-10px font-black uppercase tracking-wider text-red-200/65">
                Fuera de stock
              </p>
              <p className="mt-1 text-xl font-black text-red-300">
                {number(nonSellableReturnQuantity)}
              </p>
            </div>
            <div className="rounded-xl border border-amber-300/18 bg-amber-300/7 p-3 text-center">
              <p className="text-10px font-black uppercase tracking-wider text-amber-100/65">
                Pendientes
              </p>
              <p className="mt-1 text-xl font-black text-amber-200">
                {pendingReturn}
              </p>
            </div>
          </div>
        </div>
      </AdminModal>

      <AdminModal
        open={Boolean(pendingDelete)}
        eyebrow="Ventas ML"
        title="Eliminar venta importada"
        description="La venta se quitará de este panel y de sus métricas. Esta acción no modifica nada en Mercado Libre."
        onClose={() => {
          if (!deletingId) setPendingDelete(null)
        }}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AdminSecondaryButton
              title="Cancelar eliminación"
              aria-label="Cancelar eliminación"
              disabled={Boolean(deletingId)}
              onClick={() => setPendingDelete(null)}
            >
              Cancelar
            </AdminSecondaryButton>
            <AdminDangerButton
              title="Confirmar eliminación"
              aria-label="Confirmar eliminación"
              disabled={!pendingDelete || Boolean(deletingId)}
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete)
              }}
            >
              {deletingId ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Eliminar venta
            </AdminDangerButton>
          </div>
        }
      >
        <div className="rounded-2xl border border-red-400/18 bg-red-400/7 p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-red-400/22 bg-red-400/10 text-red-300">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-black text-white">
                Venta #{pendingDelete?.operation_id ?? pendingDelete?.id}
              </p>
              <p className="mt-1 truncate text-xs text-white/55">
                {pendingDelete?.product_name}
              </p>
              <p className="mt-3 text-xs leading-5 text-white/48">
                Si volvés a importar el mismo Excel, esta venta aparecerá
                nuevamente. Las ventas con el mismo número se reemplazan, por
                lo que no se generan duplicados.
              </p>
            </div>
          </div>
        </div>
      </AdminModal>
    </div>
  )
}
