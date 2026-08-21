"use client"

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Boxes,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  WalletCards,
  X,
} from "lucide-react"

import {
  createBusinessCost,
  createCostCatalogArticle,
  deleteBusinessCost,
  getBusinessCosts,
  type BusinessCostsData,
  type ProductCostEntry,
  updateBusinessCost,
} from "@/lib/supabase/queries/business-costs"
import {
  uniqueAutocompleteValues,
  withoutTrailingProductColor,
} from "@/lib/admin/product-name-autocomplete"
import {
  getOrCreateIdempotencyAttempt,
  type IdempotencyAttempt,
} from "@/lib/business/idempotency-attempt"
import { formatPrice } from "../productos/helpers"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { useAuth } from "@/context/auth-context"
import {
  AdminDangerButton,
  AdminModal,
  AdminSecondaryButton,
} from "../../components/admin-controls"

type CostMode = "product" | "expense"
type PurchaseSortKey =
  | "product"
  | "sku"
  | "unitCost"
  | "subtotal"
  | "supplier"
  | "date"
  | "quantity"
type PurchaseSortDirection = "asc" | "desc"

function PurchaseSortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  align = "center",
  onSort,
}: {
  label: string
  sortKey: PurchaseSortKey
  activeKey: PurchaseSortKey
  direction: PurchaseSortDirection
  align?: "left" | "center"
  onSort: (key: PurchaseSortKey) => void
}) {
  const active = sortKey === activeKey
  const Icon = active
    ? direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown
  const nextDirection = active && direction === "asc" ? "descendente" : "ascendente"

  return (
    <th className={`px-3 py-2.5 ${align === "left" ? "text-left" : "text-center"}`}>
      <span
        className={`inline-flex items-center gap-1.5 ${
          align === "left" ? "justify-start" : "justify-center"
        }`}
      >
        {label}
        <button
          type="button"
          aria-label={`Ordenar ${label.toLocaleLowerCase("es")} de forma ${nextDirection}`}
          title={`Ordenar por ${label}`}
          onClick={() => onSort(sortKey)}
          className={`admin-column-sort-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border transition ${
            active
              ? "border-beyonix-sky/42 bg-beyonix-blue/35 text-beyonix-sky"
              : "border-white/10 bg-white/4 text-white/38 hover:border-beyonix-sky/30 hover:text-white/75"
          }`}
        >
          <Icon className="size-3" />
        </button>
      </span>
    </th>
  )
}

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
  "Donación/Regalo",
  "Sorteo/Evento",
  "Producto dañado/perdido",
  "Otros",
]

const PRODUCT_EXPENSE_CATEGORIES = new Set([
  "Donación/Regalo",
  "Sorteo/Evento",
  "Producto dañado/perdido",
])
// Categorías que son siempre una salida de stock (nunca de dinero): no
// tiene sentido preguntar "Dinero o Productos" para una unidad rota.
const PRODUCT_ONLY_EXPENSE_CATEGORIES = new Set(["Producto dañado/perdido"])

function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date())
}

const DEFAULT_OTHER_COST = "600"
const OTHER_COST_STORAGE_KEY = "beyonix-admin-last-other-cost"

function getStoredOtherCost() {
  if (typeof window === "undefined") return DEFAULT_OTHER_COST
  return window.localStorage.getItem(OTHER_COST_STORAGE_KEY) || DEFAULT_OTHER_COST
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

function normalizeHex(value: string) {
  const clean = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : "#000000"
}

function ColorPickerInput({ colorHex, colorName, onColorHexChange, onColorNameChange }: {
  colorHex: string
  colorName: string
  onColorHexChange: (value: string) => void
  onColorNameChange: (value: string) => void
}) {
  return (
    <div className="relative">
      <input
        value={colorName}
        placeholder="Por ej: Verde"
        aria-label="Nombre del color"
        maxLength={160}
        onChange={(event) => onColorNameChange(event.target.value)}
        className={`${inputClass} pl-11`}
      />
      <span
        className="absolute left-2 top-1/2 size-7 -translate-y-1/2 cursor-pointer overflow-hidden rounded-lg border-2 border-white/20"
        style={{ backgroundColor: normalizeHex(colorHex) }}
      >
        <input
          type="color"
          value={normalizeHex(colorHex)}
          aria-label="Elegir color"
          onChange={(event) => onColorHexChange(event.target.value.toUpperCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
    </div>
  )
}

function MoneyInput({ value, onChange, placeholder = "0", ariaLabel }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
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
        aria-label={ariaLabel}
        onChange={(event) => onChange(numeric(event.target.value))}
        className={`${inputClass} pl-7`}
      />
    </div>
  )
}

function HistoryAutocompleteInput({
  value,
  suggestions,
  onChange,
  placeholder,
  maxLength,
  autoFocus = false,
}: {
  value: string
  suggestions: string[]
  onChange: (value: string) => void
  placeholder: string
  maxLength?: number
  autoFocus?: boolean
}) {
  const listId = useId()

  return (
    <>
      <input
        value={value}
        list={suggestions.length ? listId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </>
  )
}

function SummaryCard({ label, value, detail }: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-xl border border-beyonix-blue-light/14 bg-[rgba(3,7,13,0.72)] px-3 py-2.5">
      <p className="text-10px font-black uppercase tracking-widest text-white/40">{label}</p>
      <p className="mt-1 text-base font-black tabular-nums text-white">{value}</p>
      <p className="mt-1 text-11px font-semibold text-white/38">{detail}</p>
    </div>
  )
}

function ProductSelect({
  value,
  products,
  onChange,
  inventoryMode = false,
}: {
  value: string
  products: BusinessCostsData["catalog"]
  onChange: (value: string) => void
  inventoryMode?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const optionValue = (product: BusinessCostsData["catalog"][number]) =>
    product.standalone_key ? `c:${product.standalone_key}` : `p:${product.id}`
  const selectedProduct = products.find((product) =>
    value === optionValue(product) ||
    (!product.standalone_key && value.startsWith(`v:${product.id}:`)),
  )
  const selectedVariant = selectedProduct?.producto_variantes?.find(
    (variant) => value === `v:${selectedProduct.id}:${variant.id}`,
  )
  const isCreatingNewArticle = value === "custom"
  const normalizedSearch = search
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es")
  const filteredProducts = products.filter((product) =>
    (!inventoryMode || !product.standalone_key) &&
    `${product.nombre} ${product.sku ?? ""} ${
      product.producto_variantes
        ?.map((variant) => `${variant.nombre} ${variant.sku ?? ""}`)
        .join(" ") ?? ""
    }`
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("es")
      .includes(normalizedSearch),
  )

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
        onClick={() => {
          setOpen((current) => !current)
          if (open) setSearch("")
        }}
        className={`${inputClass} group flex cursor-pointer items-center justify-between gap-3 !border-beyonix-sky/48 !bg-[linear-gradient(135deg,rgba(17,42,67,0.72),rgba(7,17,27,0.98))] px-3 shadow-[inset_0_0_0_1px_rgba(140,200,242,0.08),0_0_18px_rgba(30,77,123,0.12)] hover:!border-beyonix-sky/75 hover:!bg-[linear-gradient(135deg,rgba(30,77,123,0.76),rgba(7,19,31,0.98))] focus:!border-beyonix-sky/80 ${open ? "ring-1 ring-beyonix-sky/45" : ""}`}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-beyonix-sky/35 bg-beyonix-blue/45 text-beyonix-sky shadow-[0_0_12px_rgba(140,200,242,0.12)] transition group-hover:border-beyonix-sky/60 group-hover:text-white">
          <Boxes className="size-4" />
        </span>
        <span className={`min-w-0 flex-1 truncate ${selectedProduct || isCreatingNewArticle ? "text-white" : "text-white/88"}`}>
          {isCreatingNewArticle
            ? "Crear artículo nuevo"
            : selectedVariant
              ? `${selectedProduct?.nombre} · ${selectedVariant.nombre}`
              : selectedProduct?.nombre ?? "Seleccionar producto"}
        </span>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-beyonix-sky/28 bg-black/20 text-beyonix-sky transition group-hover:border-beyonix-sky/55 group-hover:bg-beyonix-blue/45 group-hover:text-white">
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-30 mt-2 max-h-280px overflow-y-auto rounded-2xl border border-beyonix-sky/50 bg-[#07131F] p-1.5 shadow-[0_24px_55px_rgba(0,0,0,0.72),0_0_0_1px_rgba(140,200,242,0.08),0_0_28px_rgba(30,77,123,0.18)] custom-scrollbar">
          <label className="relative mb-1 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-beyonix-sky/65" />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por nombre o SKU..."
              className="h-9 w-full rounded-xl border border-beyonix-blue-light/18 bg-black/20 pl-9 pr-3 text-xs font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-sky/50"
            />
          </label>
          {!inventoryMode && (
            <button
              type="button"
              role="option"
              aria-selected={isCreatingNewArticle}
              onClick={() => {
                onChange("custom")
                setOpen(false)
                setSearch("")
              }}
              className={`mb-1 flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left text-sm font-bold transition ${isCreatingNewArticle ? "border-beyonix-sky/45 bg-beyonix-blue/55 text-white" : "border-beyonix-sky/20 text-beyonix-sky hover:bg-beyonix-blue/24"}`}
            >
              <span className="truncate">Crear artículo nuevo</span>
              <Plus className="size-4 shrink-0" />
            </button>
          )}
          {filteredProducts.map((product) => {
            const productValue = optionValue(product)
            const active = productValue === value
            const hasVariants = Boolean(product.producto_variantes?.length)
            const availableStock = Number(product.stock ?? 0)
            // Un producto con variantes nunca se compra "a nivel producto":
            // toda compra debe quedar tagueada a una variante concreta
            // (SKU/color), para que el stock quede asignado desde el momento
            // en que se valida la compra, sin un paso de asignación posterior.
            const productDisabled =
              hasVariants || (inventoryMode && availableStock <= 0)
            return (
              <div key={product.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  aria-disabled={productDisabled}
                  disabled={productDisabled}
                  onClick={() => {
                    onChange(productValue)
                    setOpen(false)
                    setSearch("")
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-bold transition ${productDisabled ? "cursor-not-allowed text-white/28" : active ? "cursor-pointer bg-beyonix-blue/55 text-white" : "cursor-pointer text-white/68 hover:bg-beyonix-blue/24 hover:text-white"}`}
                >
                  <span className="min-w-0 truncate">
                    {product.nombre}
                    {product.sku && <span className="ml-2 text-10px text-white/38">{product.sku}</span>}
                  </span>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-10px font-black ${product.activo ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-300" : "border-white/10 bg-white/5 text-white/38"}`}>
                    {hasVariants
                      ? "Elegí una variante"
                      : inventoryMode
                        ? `${availableStock} disponibles`
                        : product.activo ? "Activo" : "Inactivo"}
                  </span>
                </button>
                {!product.standalone_key && product.producto_variantes?.map((variant) => {
                  const variantValue = `v:${product.id}:${variant.id}`
                  const variantActive = variantValue === value
                  const variantStock = Number(variant.stock ?? 0)
                  const variantDisabled = inventoryMode && variantStock <= 0
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      role="option"
                      aria-selected={variantActive}
                      aria-disabled={variantDisabled}
                      disabled={variantDisabled}
                      onClick={() => {
                        onChange(variantValue)
                        setOpen(false)
                        setSearch("")
                      }}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl py-2 pl-7 pr-3 text-left text-xs font-bold transition ${variantDisabled ? "cursor-not-allowed text-white/25" : variantActive ? "cursor-pointer bg-beyonix-blue/55 text-white" : "cursor-pointer text-white/52 hover:bg-beyonix-blue/24 hover:text-white"}`}
                    >
                      <span className="truncate">
                        ↳ {variant.nombre}
                        {variant.sku && (
                          <span className="ml-2 text-10px text-white/38">
                            {variant.sku}
                          </span>
                        )}
                      </span>
                      <span className="text-10px text-white/35">
                        {inventoryMode ? `${variantStock} disponibles` : "Variante"}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
          {!filteredProducts.length && <p className="px-3 py-4 text-center text-xs font-semibold text-white/42">No se encontraron productos.</p>}
        </div>
      )}
    </div>
  )
}

function ModernSelect({
  value,
  options,
  onChange,
  ariaLabel,
  compact = false,
  centered = false,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  ariaLabel?: string
  compact?: boolean
  centered?: boolean
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
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`${inputClass} flex cursor-pointer items-center justify-between gap-3 hover:bg-beyonix-blue/12 ${compact ? "!h-8 !rounded-lg !px-3 !text-xs" : "px-4"}`}
      >
        <span className="w-4 shrink-0" />
        <span className={`min-w-0 flex-1 truncate ${centered ? "text-center" : ""}`}>
          {selected?.label ?? "Seleccionar"}
        </span>
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
                className={`relative flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition ${centered ? "justify-center text-center" : "justify-between"} ${active ? "bg-beyonix-blue/55 text-white" : "text-white/68 hover:bg-beyonix-blue/24 hover:text-white"}`}
              >
                <span>{option.label}</span>
                {active && (
                  <Check
                    className={`size-4 text-emerald-300 ${centered ? "absolute right-3" : ""}`}
                  />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AdminCostsPanel({ onChanged }: { onChanged?: () => void }) {
  const { isSuperAdmin } = useAuth()
  const productFormRef = useRef<HTMLElement>(null)
  const productCreateAttemptRef = useRef<IdempotencyAttempt | null>(null)
  const newArticleCreateAttemptRef = useRef<IdempotencyAttempt | null>(null)
  const expenseCreateAttemptRef = useRef<IdempotencyAttempt | null>(null)
  const [data, setData] = useState<BusinessCostsData | null>(null)
  const [mode, setMode] = useState<CostMode>("product")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [pendingDelete, setPendingDelete] = useState<
    { kind: CostMode; id: string; message: string } | null
  >(null)
  const [pendingForceDelete, setPendingForceDelete] = useState<
    { kind: CostMode; id: string } | null
  >(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [purchaseSort, setPurchaseSort] = useState<PurchaseSortKey>("date")
  const [purchaseSortDirection, setPurchaseSortDirection] =
    useState<PurchaseSortDirection>("desc")
  const [purchaseNameFilter, setPurchaseNameFilter] = useState("")
  const [purchaseQuantityFrom, setPurchaseQuantityFrom] = useState("")
  const [purchaseQuantityTo, setPurchaseQuantityTo] = useState("")
  const [purchasePriceFrom, setPurchasePriceFrom] = useState("")
  const [purchasePriceTo, setPurchasePriceTo] = useState("")
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [article, setArticle] = useState("")
  const [customArticleName, setCustomArticleName] = useState("")
  const [newArticleColor, setNewArticleColor] = useState("")
  const [newArticleColorName, setNewArticleColorName] = useState("")
  const [newArticleBarcode, setNewArticleBarcode] = useState("")
  const [productSku, setProductSku] = useState("")
  const [purchaseDate, setPurchaseDate] = useState(today)
  const [quantity, setQuantity] = useState("")
  const [receivedQuantity, setReceivedQuantity] = useState("")
  const [purchaseReception, setPurchaseReception] = useState<
    "pendiente" | "parcial" | "recibida" | "anulada"
  >("recibida")
  const [unitCost, setUnitCost] = useState("")
  const [freightCost, setFreightCost] = useState("")
  const [otherCost, setOtherCost] = useState(getStoredOtherCost)
  const [productSupplier, setProductSupplier] = useState("")
  const [productDocumentType, setProductDocumentType] = useState("")
  const [productDocumentNumber, setProductDocumentNumber] = useState("")
  const [productPaymentMethod, setProductPaymentMethod] = useState("")
  const [productNotes, setProductNotes] = useState("")
  const [expenseDate, setExpenseDate] = useState(today)
  const [expenseCategory, setExpenseCategory] = useState("Monotributo")
  const [expenseType, setExpenseType] = useState<"money" | "product">("money")
  const [expenseProduct, setExpenseProduct] = useState("")
  const [expenseProductQuantity, setExpenseProductQuantity] = useState("")
  const [expenseCategoryDetail, setExpenseCategoryDetail] = useState("")
  const [expenseRecipient, setExpenseRecipient] = useState("")
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

  const getProductCostName = useCallback(
    (item: ProductCostEntry) => {
      const key =
        item.product_id == null
          ? ""
          : item.variant_id
            ? `v:${item.product_id}:${item.variant_id}`
            : `p:${item.product_id}`

      return (
        item.article_name ||
        productNames.get(key) ||
        (item.product_id == null
          ? "Artículo no catalogado"
          : `Producto #${item.product_id}`)
      )
    },
    [productNames],
  )

  const historicalArticleNames = useMemo(
    () => (data?.productCosts ?? []).map(getProductCostName),
    [data?.productCosts, getProductCostName],
  )

  const articleNameSuggestions = useMemo(
    () =>
      uniqueAutocompleteValues([
        ...historicalArticleNames.map(withoutTrailingProductColor),
        ...(data?.catalog ?? []).map((product) =>
          withoutTrailingProductColor(product.nombre),
        ),
      ]),
    [data?.catalog, historicalArticleNames],
  )

  const latestArticleBase =
    withoutTrailingProductColor(historicalArticleNames[0] ?? "")

  const supplierSuggestions = useMemo(
    () =>
      uniqueAutocompleteValues([
        ...(data?.productCosts ?? []).map((item) => item.supplier),
        ...(data?.expenses ?? []).map((item) => item.supplier),
      ]),
    [data?.expenses, data?.productCosts],
  )

  const paymentMethodSuggestions = useMemo(
    () =>
      uniqueAutocompleteValues([
        ...(data?.productCosts ?? []).map((item) => item.payment_method),
        ...(data?.expenses ?? []).map((item) => item.payment_method),
      ]),
    [data?.expenses, data?.productCosts],
  )

  const notesSuggestions = useMemo(
    () =>
      uniqueAutocompleteValues([
        ...(data?.productCosts ?? []).map((item) => item.notes),
        ...(data?.expenses ?? []).map((item) => item.notes),
      ]),
    [data?.expenses, data?.productCosts],
  )

  const sortedProductCosts = useMemo(() => {
    const normalizedNameFilter = purchaseNameFilter
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("es")
    const quantityFrom = purchaseQuantityFrom
      ? Number(purchaseQuantityFrom)
      : null
    const quantityTo = purchaseQuantityTo
      ? Number(purchaseQuantityTo)
      : null
    const priceFrom = purchasePriceFrom
      ? Number(purchasePriceFrom)
      : null
    const priceTo = purchasePriceTo
      ? Number(purchasePriceTo)
      : null
    const rows = (data?.productCosts ?? []).filter((item) => {
      const normalizedName = getProductCostName(item)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("es")

      if (normalizedNameFilter && !normalizedName.includes(normalizedNameFilter)) {
        return false
      }
      const itemQuantity = Number(item.quantity)
      const itemPrice = Number(item.unit_cost)

      if (quantityFrom !== null && itemQuantity < quantityFrom) {
        return false
      }
      if (quantityTo !== null && itemQuantity > quantityTo) {
        return false
      }
      if (priceFrom !== null && itemPrice < priceFrom) {
        return false
      }
      if (priceTo !== null && itemPrice > priceTo) {
        return false
      }

      return true
    })
    const compareText = (left: string, right: string) =>
      left.localeCompare(right, "es", {
        sensitivity: "base",
        numeric: true,
      })

    rows.sort((left, right) => {
      let comparison = 0

      switch (purchaseSort) {
        case "product":
          comparison = compareText(
            getProductCostName(left),
            getProductCostName(right),
          )
          break
        case "sku": {
          const leftSku = left.sku?.trim()
          const rightSku = right.sku?.trim()
          if (!leftSku && !rightSku) return 0
          if (!leftSku) return 1
          if (!rightSku) return -1
          comparison = compareText(leftSku, rightSku)
          break
        }
        case "unitCost":
          comparison = Number(left.unit_cost) - Number(right.unit_cost)
          break
        case "subtotal":
          comparison = Number(left.total_cost) - Number(right.total_cost)
          break
        case "supplier": {
          const leftSupplier = left.supplier?.trim()
          const rightSupplier = right.supplier?.trim()
          if (!leftSupplier && !rightSupplier) return 0
          if (!leftSupplier) return 1
          if (!rightSupplier) return -1
          comparison = compareText(leftSupplier, rightSupplier)
          break
        }
        case "quantity":
          comparison = Number(left.quantity) - Number(right.quantity)
          break
        case "date":
        default: {
          comparison = left.purchase_date.localeCompare(
            right.purchase_date,
          )
          comparison ||= left.created_at.localeCompare(right.created_at)
          break
        }
      }

      return purchaseSortDirection === "desc" ? -comparison : comparison
    })

    return rows
  }, [
    data?.productCosts,
    getProductCostName,
    purchaseNameFilter,
    purchasePriceFrom,
    purchasePriceTo,
    purchaseQuantityFrom,
    purchaseQuantityTo,
    purchaseSort,
    purchaseSortDirection,
  ])

  const handlePurchaseSort = (key: PurchaseSortKey) => {
    if (purchaseSort === key) {
      setPurchaseSortDirection((current) =>
        current === "asc" ? "desc" : "asc",
      )
      return
    }

    setPurchaseSort(key)
    setPurchaseSortDirection("asc")
  }

  const unregisteredCatalogTargets = useMemo(() => {
    const registered = new Set(
      (data?.productCosts ?? []).flatMap((item) => {
        if (item.product_id == null) return []
        return [
          item.variant_id
            ? `v:${item.product_id}:${item.variant_id}`
            : `p:${item.product_id}`,
        ]
      }),
    )

    return (data?.catalog ?? []).flatMap((product) => {
      if (product.standalone_key || typeof product.id !== "number") return []

      const variants = [...(product.producto_variantes ?? [])].sort(
        (left, right) => left.id - right.id,
      )
      if (variants.length) {
        // Una compra anterior a la creación de variantes pertenece a la
        // primera variante agregada; no debe solicitarse nuevamente.
        const hasLegacyProductPurchase = registered.has(`p:${product.id}`)
        const legacyVariantId = hasLegacyProductPurchase ? variants[0]?.id : null

        return variants
          .map((variant) => ({
            value: `v:${product.id}:${variant.id}`,
            label: `${product.nombre} · ${variant.nombre}`,
            sku: variant.sku ?? "",
            coveredByLegacyPurchase: variant.id === legacyVariantId,
          }))
          .filter(
            (target) =>
              !target.coveredByLegacyPurchase && !registered.has(target.value),
          )
      }

      const target = {
        value: `p:${product.id}`,
        label: product.nombre,
        sku: product.sku ?? "",
      }
      return registered.has(target.value) ? [] : [target]
    })
  }, [data?.catalog, data?.productCosts])

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

  const resetProductForm = () => {
    productCreateAttemptRef.current = null
    newArticleCreateAttemptRef.current = null
    setEditingProductId(null)
    setArticle("")
    setCustomArticleName("")
    setNewArticleColor("")
    setNewArticleColorName("")
    setNewArticleBarcode("")
    setProductSku("")
    setPurchaseDate(today())
    setQuantity("")
    setReceivedQuantity("")
    setPurchaseReception("recibida")
    setUnitCost("")
    setFreightCost("")
    setOtherCost(getStoredOtherCost())
    setProductSupplier("")
    setProductDocumentType("")
    setProductDocumentNumber("")
    setProductPaymentMethod("")
    setProductNotes("")
  }

  const editProduct = (item: ProductCostEntry) => {
    setEditingProductId(item.id)
    setArticle(
      item.product_id == null
        ? "custom"
        : item.variant_id
          ? `v:${item.product_id}:${item.variant_id}`
          : `p:${item.product_id}`,
    )
    setCustomArticleName((item.article_name ?? "").toUpperCase())
    const linkedProduct =
      item.product_id != null
        ? data?.catalog.find(
            (product) =>
              !product.standalone_key && Number(product.id) === item.product_id,
          )
        : undefined
    const linkedVariant =
      item.variant_id != null
        ? linkedProduct?.producto_variantes?.find(
            (variant) => variant.id === item.variant_id,
          )
        : undefined
    setNewArticleColor(linkedVariant?.color_hex ?? "")
    setNewArticleColorName(linkedVariant ? linkedVariant.nombre.toUpperCase() : "")
    setNewArticleBarcode(
      (linkedVariant ? linkedVariant.codigo_barra : linkedProduct?.codigo_barra) ?? "",
    )
    setProductSku((item.sku ?? "").toUpperCase())
    setPurchaseDate(item.purchase_date)
    setQuantity(String(item.quantity))
    setReceivedQuantity(String(item.received_quantity ?? item.quantity))
    setPurchaseReception(item.reception_status ?? "recibida")
    setUnitCost(String(item.unit_cost))
    setFreightCost(Number(item.freight_cost) ? String(item.freight_cost) : "")
    setOtherCost(Number(item.other_cost) ? String(item.other_cost) : "")
    setProductSupplier(item.supplier ?? "")
    setProductDocumentType(item.document_type ?? "")
    setProductDocumentNumber(item.document_number ?? "")
    setProductPaymentMethod(item.payment_method ?? "")
    setProductNotes(item.notes ?? "")
    setError("")
    setMessage("")
    requestAnimationFrame(() => {
      productFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const startPurchaseForCatalogTarget = (
    value: string,
    sku: string,
  ) => {
    resetProductForm()
    setArticle(value)
    setProductSku(sku.toUpperCase())
    setError("")
    setMessage("Completá la cantidad recibida y el costo para registrar el ingreso.")
    requestAnimationFrame(() => {
      productFormRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    })
  }

  const saveProduct = async () => {
    const isNewArticle = article === "custom"
    const parts = article.split(":")
    let productId = parts[0] === "p" || parts[0] === "v" ? parts[1] : null
    let variantId = parts[0] === "v" ? parts[2] : null
    const standaloneProduct = data?.catalog.find(
      (product) => product.standalone_key && article === `c:${product.standalone_key}`,
    )
    const newArticleName = customArticleName.trim()
    const newArticleColorHex = newArticleColor.trim()
    const newArticleColorNameValue = newArticleColorName.trim()
    const newArticleBarcodeValue = newArticleBarcode.trim()
    const articleName = isNewArticle
      ? ""
      : standaloneProduct?.nombre.trim() ?? ""
    const showsCatalogArticleFields = isNewArticle || Boolean(productId)

    if (
      (!productId && !isNewArticle && !articleName) ||
      (isNewArticle && !newArticleName) ||
      (isNewArticle && !productSku.trim()) ||
      (isNewArticle && !newArticleColorHex) ||
      (isNewArticle && !newArticleColorNameValue) ||
      !purchaseDate ||
      !quantity ||
      !unitCost ||
      (isNewArticle && !freightCost) ||
      (purchaseReception === "parcial" && !receivedQuantity)
    ) {
      setError(
        isNewArticle
          ? "Completá nombre, SKU, color, cantidad, costo unitario y flete."
          : "Completá artículo, fecha, cantidad y costo unitario.",
      )
      return
    }
    if (
      purchaseReception === "parcial" &&
      (Number(receivedQuantity) <= 0 ||
        Number(receivedQuantity) >= Number(quantity))
    ) {
      setError("La recepción parcial debe ser mayor que cero y menor que la cantidad comprada.")
      return
    }
    if (
      showsCatalogArticleFields &&
      newArticleColorHex &&
      !/^#[0-9A-Fa-f]{6}$/.test(newArticleColorHex)
    ) {
      setError("El color elegido no es válido.")
      return
    }
    if (showsCatalogArticleFields && newArticleColorNameValue && !newArticleColorHex) {
      setError("Elegí un color con el selector para poder ponerle nombre.")
      return
    }

    try {
      setSaving(true)
      setError("")
      setMessage("")

      if (showsCatalogArticleFields) {
        const articlePayload = {
          productId: isNewArticle ? null : productId,
          variantId: isNewArticle ? null : variantId,
          name: newArticleName,
          sku: productSku,
          colorHex: newArticleColorHex || null,
          colorName: newArticleColorNameValue || null,
          barcode: newArticleBarcodeValue || null,
        }
        const attempt = getOrCreateIdempotencyAttempt(
          newArticleCreateAttemptRef.current,
          articlePayload,
        )
        newArticleCreateAttemptRef.current = attempt
        const created = await createCostCatalogArticle(articlePayload, attempt.key)
        newArticleCreateAttemptRef.current = null
        productId = String(created.productId)
        variantId = created.variantId != null ? String(created.variantId) : null
      }

      const payload = {
        kind: "product",
        id: editingProductId,
        productId,
        variantId,
        articleName,
        sku: productSku,
        purchaseDate,
        quantity,
        receivedQuantity:
          purchaseReception === "recibida"
            ? quantity
            : purchaseReception === "parcial"
              ? receivedQuantity
              : 0,
        receptionStatus: purchaseReception,
        unitCost,
        freightCost,
        otherCost,
        supplier: productSupplier,
        documentType: productDocumentType,
        documentNumber: productDocumentNumber,
        paymentMethod: productPaymentMethod,
        notes: productNotes,
      }
      if (editingProductId) {
        await updateBusinessCost(payload)
      } else {
        const attempt = getOrCreateIdempotencyAttempt(
          productCreateAttemptRef.current,
          payload,
        )
        productCreateAttemptRef.current = attempt
        await createBusinessCost(payload, attempt.key)
        productCreateAttemptRef.current = null
      }
      const successMessage = editingProductId
        ? "Compra actualizada correctamente."
        : "Compra guardada correctamente."
      window.localStorage.setItem(
        OTHER_COST_STORAGE_KEY,
        otherCost || DEFAULT_OTHER_COST,
      )
      resetProductForm()
      setMessage(successMessage)
      await load()
      onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la compra.")
    } finally {
      setSaving(false)
    }
  }

  const saveExpense = async () => {
    if (!expenseDate || !expenseCategory) {
      setError("Completá fecha y categoría.")
      return
    }

    if (expenseCategory === "Donación/Regalo" && !expenseRecipient.trim()) {
      setError("Indicá a quién fue dirigida la donación o el regalo.")
      return
    }

    if (expenseType === "money" && !expenseAmount) {
      setError("Completá el importe.")
      return
    }

    const productParts = expenseProduct.split(":")
    const expenseProductId =
      productParts[0] === "p" || productParts[0] === "v"
        ? productParts[1]
        : null
    const expenseVariantId = productParts[0] === "v" ? productParts[2] : null

    if (
      expenseType === "product" &&
      (!expenseProductId || !expenseProductQuantity)
    ) {
      setError("Seleccioná un artículo y la cantidad que salió del stock.")
      return
    }

    const selectedExpenseProduct = data?.catalog.find(
      (product) => String(product.id) === expenseProductId,
    )
    const selectedExpenseVariant =
      selectedExpenseProduct?.producto_variantes?.find(
        (variant) => String(variant.id) === expenseVariantId,
      )

    try {
      setSaving(true)
      setError("")
      setMessage("")
      const payload = {
        kind: "expense",
        expenseDate,
        category: expenseCategory,
        expenseType,
        productId: expenseProductId,
        variantId: expenseVariantId,
        productSku:
          selectedExpenseVariant?.sku ??
          selectedExpenseProduct?.sku ??
          "",
        quantity: expenseProductQuantity,
        categoryDetail: expenseCategoryDetail,
        recipient: expenseRecipient,
        description: expenseDescription,
        amount: expenseType === "product" ? "0" : expenseAmount,
        recurrence: expenseType === "product" ? "unico" : expenseRecurrence,
        status: expenseType === "product" ? "pagado" : expenseStatus,
        supplier: expenseSupplier,
        paymentMethod: expensePaymentMethod,
        documentType: expenseDocumentType,
        documentNumber: expenseDocumentNumber,
        taxDeductible: expenseTaxDeductible,
        notes: expenseNotes,
      }
      const attempt = getOrCreateIdempotencyAttempt(
        expenseCreateAttemptRef.current,
        payload,
      )
      expenseCreateAttemptRef.current = attempt
      await createBusinessCost(payload, attempt.key)
      expenseCreateAttemptRef.current = null
      setExpenseDescription("")
      setExpenseCategoryDetail("")
      setExpenseRecipient("")
      setExpenseType("money")
      setExpenseProduct("")
      setExpenseProductQuantity("")
      setExpenseAmount("")
      setExpenseNotes("")
      setMessage("Gasto guardado correctamente.")
      await load()
      onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar el gasto.")
    } finally {
      setSaving(false)
    }
  }

  const requestRemove = (kind: CostMode, id: string) => {
    const restoresInventory =
      kind === "expense" &&
      data?.expenses.some((item) => item.id === id && item.expense_type === "product")
    setError("")
    setPendingDelete({
      kind,
      id,
      message: restoresInventory
        ? "Las unidades se reintegrarán al stock."
        : "Esta acción no se puede deshacer.",
    })
  }

  const confirmRemove = async () => {
    if (!pendingDelete) return
    const { kind, id } = pendingDelete
    try {
      setDeletingId(id)
      setError("")
      await deleteBusinessCost(kind, id)
      if (kind === "product" && editingProductId === id) resetProductForm()
      await load()
      onChanged?.()
      setPendingDelete(null)
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "No se pudo eliminar el movimiento."
      const stockConflict = kind === "product" && /consumida/i.test(message)
      setPendingDelete(null)
      if (stockConflict && isSuperAdmin) {
        setPendingForceDelete({ kind, id })
        return
      }
      setError(message)
    } finally {
      setDeletingId(null)
    }
  }

  const confirmForceRemove = async () => {
    if (!pendingForceDelete) return
    const { kind, id } = pendingForceDelete
    try {
      setDeletingId(id)
      setError("")
      await deleteBusinessCost(kind, id, { force: true })
      if (editingProductId === id) resetProductForm()
      await load()
      onChanged?.()
      setPendingForceDelete(null)
    } catch (forceCause) {
      setError(
        forceCause instanceof Error
          ? forceCause.message
          : "No se pudo forzar la eliminación de la compra.",
      )
    } finally {
      setDeletingId(null)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-200px items-center justify-center rounded-2xl border border-beyonix-blue-light/16 bg-[#071018]">
        <Loader2 className="size-6 animate-spin text-beyonix-sky" />
      </div>
    )
  }

  return (
    <div className="admin-dashboard-panel admin-costs-panel space-y-3">
      <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[linear-gradient(145deg,rgba(7,16,24,0.9),rgba(3,7,13,0.96))] p-3.5 sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">Contabilidad interna</p>
            <h2 className="mt-1 text-xl font-black text-white">Compras</h2>
            <p className="mt-1 text-xs font-semibold text-white/45">Adquisiciones, recepción, impuestos y gastos con historial.</p>
          </div>
          <div className="inline-flex rounded-2xl border border-beyonix-blue-light/20 bg-black/30 p-1">
            <button type="button" onClick={() => setMode("product")} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl px-4 text-xs font-black transition ${mode === "product" ? "bg-beyonix-blue/60 text-white" : "text-white/55 hover:text-white"}`}><Boxes className="size-4" /> Mercadería</button>
            <button type="button" onClick={() => setMode("expense")} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl px-4 text-xs font-black transition ${mode === "expense" ? "bg-beyonix-blue/60 text-white" : "text-white/55 hover:text-white"}`}><WalletCards className="size-4" /> Gastos</button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
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
          <section ref={productFormRef} className="scroll-mt-4 rounded-2xl border border-beyonix-blue-light/16 bg-[#071018] p-3.5 sm:p-4">
            <div className="mb-3 flex items-center gap-2">
              {editingProductId ? <Pencil className="size-4 text-beyonix-sky" /> : <Plus className="size-4 text-beyonix-sky" />}
              <h3 className="text-base font-black text-white">{editingProductId ? "Editar compra" : "Nueva compra"}</h3>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Artículo" className="xl:col-span-2">
                <ProductSelect
                  value={article}
                  products={data?.catalog ?? []}
                  onChange={(value) => {
                    setArticle(value)
                    if (value === "custom") {
                      setCustomArticleName(latestArticleBase.toUpperCase())
                    } else {
                      setCustomArticleName("")
                    }
                    const selectedProduct = data?.catalog.find((product) =>
                      value ===
                        (product.standalone_key
                          ? `c:${product.standalone_key}`
                          : `p:${product.id}`) ||
                      (!product.standalone_key &&
                        value.startsWith(`v:${product.id}:`)),
                    )
                    const selectedVariant =
                      selectedProduct?.producto_variantes?.find(
                        (variant) =>
                          value === `v:${selectedProduct.id}:${variant.id}`,
                      )
                    setProductSku(
                      (selectedVariant
                        ? selectedVariant.sku
                        : selectedProduct?.sku
                      )?.toUpperCase() ?? "",
                    )
                    if (value === "custom" || selectedProduct?.standalone_key) {
                      setNewArticleColor("")
                      setNewArticleColorName("")
                      setNewArticleBarcode("")
                    } else {
                      setNewArticleColor(selectedVariant?.color_hex ?? "")
                      setNewArticleColorName(
                        selectedVariant ? selectedVariant.nombre.toUpperCase() : "",
                      )
                      setNewArticleBarcode(
                        (selectedVariant
                          ? selectedVariant.codigo_barra
                          : selectedProduct?.codigo_barra) ?? "",
                      )
                    }
                  }}
                />
              </Field>
              {article === "custom" && (
                <Field label="Nombre del artículo" className="md:col-span-2 xl:col-span-2">
                  <HistoryAutocompleteInput
                    value={customArticleName}
                    suggestions={articleNameSuggestions}
                    onChange={(value) => setCustomArticleName(value.toUpperCase())}
                    placeholder="Por ej: Auricular"
                    maxLength={180}
                    autoFocus
                  />
                </Field>
              )}
              {(article === "custom" || article.startsWith("p:") || article.startsWith("v:")) && (
                <>
                  <Field label={article === "custom" ? "Color" : "Color (opcional)"}>
                    <ColorPickerInput
                      colorHex={newArticleColor}
                      colorName={newArticleColorName}
                      onColorHexChange={setNewArticleColor}
                      onColorNameChange={(value) => setNewArticleColorName(value.toUpperCase())}
                    />
                  </Field>
                  <Field label="Código de barra (opcional)">
                    <input
                      value={newArticleBarcode}
                      onChange={(event) => setNewArticleBarcode(event.target.value)}
                      className={inputClass}
                      placeholder="Escaneá o escribí el código"
                      maxLength={64}
                    />
                  </Field>
                </>
              )}
              <Field label={article === "custom" ? "SKU" : "SKU (opcional)"}>
                <input
                  value={productSku}
                  onChange={(event) => setProductSku(event.target.value.toUpperCase())}
                  className={inputClass}
                  placeholder="Por ej: Aur-01"
                  maxLength={120}
                />
              </Field>
              <Field label="Fecha compra"><AdminDatePicker title="Fecha compra" ariaLabel="Fecha de compra" value={purchaseDate} onChange={setPurchaseDate} centered /></Field>
              <Field label="Cantidad comprada"><input value={quantity} inputMode="numeric" onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ""))} className={inputClass} placeholder="0" /></Field>
              {purchaseReception === "parcial" && (
                <Field label="Cantidad recibida">
                  <input
                    value={receivedQuantity}
                    inputMode="numeric"
                    onChange={(event) =>
                      setReceivedQuantity(event.target.value.replace(/\D/g, ""))
                    }
                    className={inputClass}
                    placeholder="0"
                  />
                </Field>
              )}
              <Field label="Costo unitario"><MoneyInput value={unitCost} onChange={setUnitCost} /></Field>
              <Field label="Proveedor"><HistoryAutocompleteInput value={productSupplier} suggestions={supplierSuggestions} onChange={setProductSupplier} placeholder="Opcional" /></Field>
              <Field label="Flete"><MoneyInput value={freightCost} onChange={setFreightCost} /></Field>
              <Field label="Otros costos"><MoneyInput value={otherCost} onChange={setOtherCost} /></Field>
              <Field label="Comprobante"><input value={productDocumentType} onChange={(event) => setProductDocumentType(event.target.value)} className={inputClass} placeholder="Factura, recibo" /></Field>
              <Field label="Número"><input value={productDocumentNumber} onChange={(event) => setProductDocumentNumber(event.target.value)} className={inputClass} placeholder="Opcional" /></Field>
              <Field label="Medio pago"><HistoryAutocompleteInput value={productPaymentMethod} suggestions={paymentMethodSuggestions} onChange={setProductPaymentMethod} placeholder="Transferencia" /></Field>
              <Field label="Notas" className="xl:col-span-2"><HistoryAutocompleteInput value={productNotes} suggestions={notesSuggestions} onChange={setProductNotes} placeholder="Detalle adicional" /></Field>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              {editingProductId && (
                <button type="button" disabled={saving} onClick={resetProductForm} className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/15 px-4 text-sm font-black text-white/65 transition hover:border-white/30 hover:text-white disabled:opacity-50">
                  <X className="size-4" /> Cancelar
                </button>
              )}
              <button type="button" disabled={saving} onClick={() => void saveProduct()} className="inline-flex h-10 min-w-130px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/35 bg-beyonix-blue/38 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/60 hover:bg-beyonix-blue/55 disabled:cursor-wait disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {editingProductId ? "Actualizar" : "Guardar"}</button>
            </div>
          </section>

          <section className="rounded-2xl border border-beyonix-blue-light/16 bg-[#071018] p-3.5 sm:p-4">
            <div className="mb-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
              <h3 className="text-base font-black text-white">
                Historial de compras
              </h3>
              <div className="grid w-full max-w-4xl gap-3 sm:grid-cols-3 md:justify-self-center">
                <Field label="Nombre">
                  <input
                    value={purchaseNameFilter}
                    onChange={(event) => setPurchaseNameFilter(event.target.value)}
                    className={inputClass}
                    placeholder="Filtrar por nombre"
                  />
                </Field>
                <Field label="Cantidad">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={purchaseQuantityFrom}
                      inputMode="numeric"
                      onChange={(event) =>
                        setPurchaseQuantityFrom(
                          event.target.value.replace(/\D/g, ""),
                        )
                      }
                      className={inputClass}
                      placeholder="Desde"
                      aria-label="Cantidad mínima"
                    />
                    <input
                      value={purchaseQuantityTo}
                      inputMode="numeric"
                      onChange={(event) =>
                        setPurchaseQuantityTo(
                          event.target.value.replace(/\D/g, ""),
                        )
                      }
                      className={inputClass}
                      placeholder="Hasta"
                      aria-label="Cantidad máxima"
                    />
                  </div>
                </Field>
                <Field label="Precio unitario">
                  <div className="grid grid-cols-2 gap-2">
                    <MoneyInput
                      value={purchasePriceFrom}
                      onChange={setPurchasePriceFrom}
                      placeholder="Desde"
                      ariaLabel="Precio unitario mínimo"
                    />
                    <MoneyInput
                      value={purchasePriceTo}
                      onChange={setPurchasePriceTo}
                      placeholder="Hasta"
                      ariaLabel="Precio unitario máximo"
                    />
                  </div>
                </Field>
              </div>
              <span className="text-xs font-bold text-white/38 md:justify-self-end">
                {sortedProductCosts.length}
                {sortedProductCosts.length !== (data?.productCosts.length ?? 0)
                  ? ` de ${data?.productCosts.length ?? 0}`
                  : ""}{" "}
                registros
              </span>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-white/7">
              <table className="w-full min-w-1100px text-sm">
                <thead className="bg-black/30 text-10px uppercase tracking-widest text-white/42">
                  <tr>
                    <PurchaseSortableHeader
                      label="Fecha"
                      sortKey="date"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      onSort={handlePurchaseSort}
                    />
                    <PurchaseSortableHeader
                      label="Artículo"
                      sortKey="product"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      align="left"
                      onSort={handlePurchaseSort}
                    />
                    <PurchaseSortableHeader
                      label="SKU"
                      sortKey="sku"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      onSort={handlePurchaseSort}
                    />
                    <PurchaseSortableHeader
                      label="Recibida / comprada"
                      sortKey="quantity"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      onSort={handlePurchaseSort}
                    />
                    <PurchaseSortableHeader
                      label="Unitario"
                      sortKey="unitCost"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      onSort={handlePurchaseSort}
                    />
                    <th className="px-3 py-2.5 text-center">Extras</th>
                    <PurchaseSortableHeader
                      label="Total"
                      sortKey="subtotal"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      onSort={handlePurchaseSort}
                    />
                    <PurchaseSortableHeader
                      label="Proveedor"
                      sortKey="supplier"
                      activeKey={purchaseSort}
                      direction={purchaseSortDirection}
                      onSort={handlePurchaseSort}
                    />
                    <th className="px-3 py-2.5 text-center">Acción</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:align-middle [&_td]:text-center [&_td:nth-child(2)]:text-left">{sortedProductCosts.map((item) => { const articleLabel = getProductCostName(item); const extras = Number(item.freight_cost) + Number(item.tax_cost) + Number(item.commission_cost) + Number(item.other_cost); const received = Number(item.received_quantity ?? item.quantity); const receptionLabel = item.reception_status === "anulada" ? "Anulada" : item.reception_status === "pendiente" ? "Pendiente" : item.reception_status === "parcial" ? "Parcial" : "Recibida"; return <tr key={item.id} className="border-t border-white/6 text-white/65"><td className="px-3 py-3">{item.purchase_date}</td><td className="px-3 py-3 font-bold text-white">{articleLabel}</td><td className="px-3 py-3 font-semibold text-white/55">{item.sku || "—"}</td><td className="px-3 py-3 tabular-nums"><span className="block">{received}/{item.quantity}</span><span className="text-10px font-bold text-white/40">{receptionLabel}</span></td><td className="px-3 py-3 tabular-nums"><span className="flex w-full items-center justify-center">{formatPrice(Number(item.unit_cost))}</span></td><td className="px-3 py-3 tabular-nums">{formatPrice(extras)}</td><td className="px-3 py-3 font-black tabular-nums text-white">{formatPrice(Number(item.total_cost))}</td><td className="px-3 py-3">{item.supplier || "—"}</td><td className="px-3 py-3"><div className="flex items-center justify-center gap-1.5"><button type="button" aria-label="Editar compra" onClick={() => editProduct(item)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-beyonix-sky/30 text-beyonix-sky transition hover:bg-beyonix-sky/10"><Pencil className="size-3.5" /></button><button type="button" aria-label="Eliminar compra" disabled={deletingId === item.id} onClick={() => requestRemove("product", item.id)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/25 text-red-300 transition hover:bg-red-400/10 disabled:cursor-wait disabled:opacity-50">{deletingId === item.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}</button></div></td></tr>})}</tbody>
              </table>
              {!sortedProductCosts.length && (
                <p className="px-4 py-8 text-center text-sm text-white/42">
                  {data?.productCosts.length
                    ? "No hay compras que coincidan con los filtros aplicados."
                    : "No hay compras registradas. Dar de alta un producto crea el catálogo, pero no registra mercadería recibida."}
                </p>
              )}
            </div>
            {unregisteredCatalogTargets.length > 0 && (
              <div className="mt-4 rounded-2xl border border-amber-300/18 bg-amber-300/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-black text-white">
                      Productos pendientes de registrar una compra
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-white/48">
                      Estos artículos existen en Productos, pero todavía no
                      tienen cantidad recibida, costo ni fecha de compra.
                    </p>
                  </div>
                  <span className="rounded-full border border-amber-300/20 bg-amber-300/8 px-2.5 py-1 text-xs font-black text-amber-200">
                    {unregisteredCatalogTargets.length} pendientes
                  </span>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {unregisteredCatalogTargets.map((target) => (
                    <div
                      key={target.value}
                      className="flex min-w-0 items-center gap-2 rounded-xl border border-white/7 bg-black/20 p-2 pl-3"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs font-bold text-white/70">
                        {target.label}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          startPurchaseForCatalogTarget(
                            target.value,
                            target.sku,
                          )
                        }
                        className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-beyonix-sky/28 bg-beyonix-blue/24 px-2.5 text-xs font-black text-beyonix-sky transition hover:border-beyonix-sky/50 hover:bg-beyonix-blue/42"
                      >
                        <Plus className="size-3.5" />
                        Registrar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="rounded-2xl border border-beyonix-blue-light/16 bg-[#071018] p-3.5 sm:p-4">
            <div className="mb-4 flex items-center gap-2"><Plus className="size-4 text-beyonix-sky" /><h3 className="text-base font-black text-white">Nuevo gasto</h3></div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Fecha gasto"><AdminDatePicker title="Fecha gasto" ariaLabel="Fecha del gasto" value={expenseDate} onChange={setExpenseDate} centered /></Field>
              <Field label="Categoría"><ModernSelect value={expenseCategory} onChange={(category) => {
                setExpenseCategory(category)
                if (category !== "Otros") setExpenseCategoryDetail("")
                if (category !== "Donación/Regalo") setExpenseRecipient("")
                if (!PRODUCT_EXPENSE_CATEGORIES.has(category)) {
                  setExpenseType("money")
                  setExpenseProduct("")
                  setExpenseProductQuantity("")
                } else if (PRODUCT_ONLY_EXPENSE_CATEGORIES.has(category)) {
                  setExpenseType("product")
                  setExpenseAmount("")
                }
              }} options={EXPENSE_CATEGORIES.map((category) => ({ value: category, label: category }))} /></Field>
              {PRODUCT_EXPENSE_CATEGORIES.has(expenseCategory) &&
                !PRODUCT_ONLY_EXPENSE_CATEGORIES.has(expenseCategory) && (
                <Field label="Tipo de entrega">
                  <ModernSelect
                    value={expenseType}
                    onChange={(value) => {
                      const nextType = value === "product" ? "product" : "money"
                      setExpenseType(nextType)
                      if (nextType === "money") {
                        setExpenseProduct("")
                        setExpenseProductQuantity("")
                      } else {
                        setExpenseAmount("")
                      }
                    }}
                    options={[
                      { value: "money", label: "Dinero" },
                      { value: "product", label: "Productos" },
                    ]}
                  />
                </Field>
              )}
              {expenseCategory === "Donación/Regalo" && (
                <Field label="Dirigido a">
                  <input
                    value={expenseRecipient}
                    onChange={(event) => setExpenseRecipient(event.target.value)}
                    className={inputClass}
                    placeholder="Nombre del destinatario"
                    maxLength={180}
                    autoFocus
                  />
                </Field>
              )}
              {expenseCategory === "Otros" && (
                <Field label="Especificar (opcional)">
                  <input
                    value={expenseCategoryDetail}
                    onChange={(event) => setExpenseCategoryDetail(event.target.value)}
                    className={inputClass}
                    placeholder="Ej. capacitación"
                    maxLength={240}
                    autoFocus
                  />
                </Field>
              )}
              {expenseType === "product" ? (
                <>
                  <Field label="Artículo" className="md:col-span-2 xl:col-span-2">
                    <ProductSelect
                      value={expenseProduct}
                      products={data?.catalog ?? []}
                      onChange={setExpenseProduct}
                      inventoryMode
                    />
                  </Field>
                  <Field label="Cantidad">
                    <input
                      value={expenseProductQuantity}
                      inputMode="numeric"
                      onChange={(event) =>
                        setExpenseProductQuantity(event.target.value.replace(/\D/g, ""))
                      }
                      className={inputClass}
                      placeholder="Unidades"
                    />
                  </Field>
                  <Field label="Descripción" className="md:col-span-2 xl:col-span-2">
                    <input
                      value={expenseDescription}
                      onChange={(event) => setExpenseDescription(event.target.value)}
                      className={inputClass}
                      placeholder="Motivo o detalle de la entrega"
                    />
                  </Field>
                  <Field label="Notas" className="md:col-span-2 xl:col-span-3">
                    <input value={expenseNotes} onChange={(event) => setExpenseNotes(event.target.value)} className={inputClass} placeholder="Detalle adicional" />
                  </Field>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
            <div className="mt-4 flex justify-end"><button type="button" disabled={saving} onClick={() => void saveExpense()} className="inline-flex h-10 min-w-130px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/35 bg-beyonix-blue/38 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/60 hover:bg-beyonix-blue/55 disabled:cursor-wait disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Guardar</button></div>
          </section>

          <section className="rounded-2xl border border-beyonix-blue-light/16 bg-[#071018] p-3.5 sm:p-4">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-base font-black text-white">Historial de gastos</h3><span className="text-xs font-bold text-white/38">{data?.expenses.length ?? 0} registros</span></div>
            <div className="overflow-x-auto rounded-2xl border border-white/7">
              <table className="w-full min-w-1000px text-sm"><thead className="bg-black/30 text-10px uppercase tracking-widest text-white/42"><tr><th className="px-3 py-2.5 text-left">Fecha</th><th className="px-3 py-2.5 text-left">Categoría</th><th className="px-3 py-2.5 text-left">Descripción</th><th className="px-3 py-2.5 text-right">Importe</th><th className="px-3 py-2.5 text-center">Estado</th><th className="px-3 py-2.5 text-center">Frecuencia</th><th className="px-3 py-2.5 text-left">Proveedor</th><th className="px-3 py-2.5 text-center">Acción</th></tr></thead>
                <tbody>{data?.expenses.map((item) => <tr key={item.id} className="border-t border-white/6 text-white/65"><td className="px-3 py-3">{item.expense_date}</td><td className="px-3 py-3"><span className="font-bold text-white">{item.category}</span>{item.recipient && <span className="mt-0.5 block text-xs text-white/48">Dirigido a: {item.recipient}</span>}{item.category_detail && <span className="mt-0.5 block text-xs text-white/48">{item.category_detail}</span>}{item.expense_type === "product" && <span className="mt-1 block text-xs font-bold text-beyonix-sky">{item.quantity} × {item.product_name}{item.product_sku ? ` · ${item.product_sku}` : ""}</span>}</td><td className="px-3 py-3">{item.description || "—"}</td><td className="px-3 py-3 text-right font-black tabular-nums text-white">{item.expense_type === "product" ? <span className="text-xs text-beyonix-sky">Salida de stock</span> : formatPrice(Number(item.amount))}</td><td className="px-3 py-3 text-center"><span className={`rounded-full border px-2.5 py-1 text-xs font-black ${item.status === "pagado" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>{item.expense_type === "product" ? "Registrado" : item.status === "pagado" ? "Pagado" : "Pendiente"}</span></td><td className="px-3 py-3 text-center capitalize">{item.recurrence}</td><td className="px-3 py-3">{item.supplier || "—"}</td><td className="px-3 py-3 text-center"><button type="button" aria-label="Eliminar gasto" disabled={deletingId === item.id} onClick={() => requestRemove("expense", item.id)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/25 text-red-300 transition hover:bg-red-400/10 disabled:cursor-wait disabled:opacity-50">{deletingId === item.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}</button></td></tr>)}</tbody>
              </table>
              {!data?.expenses.length && <p className="px-4 py-8 text-center text-sm text-white/42">Todavía no registraste gastos.</p>}
            </div>
          </section>
        </>
      )}

      {pendingDelete &&
        createPortal(
          <AdminModal
            open
            compact
            title="Eliminar movimiento"
            description={pendingDelete.message}
            onClose={() => {
              if (!deletingId) setPendingDelete(null)
            }}
            footer={
              <div className="flex items-center justify-end gap-2">
                <AdminSecondaryButton
                  disabled={Boolean(deletingId)}
                  onClick={() => setPendingDelete(null)}
                >
                  Cancelar
                </AdminSecondaryButton>
                <AdminDangerButton
                  disabled={Boolean(deletingId)}
                  onClick={() => void confirmRemove()}
                >
                  {deletingId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {deletingId ? "Eliminando…" : "Eliminar"}
                </AdminDangerButton>
              </div>
            }
          >
            <p className="text-sm text-white/60">
              ¿Querés eliminar este movimiento?
            </p>
          </AdminModal>,
          document.body,
        )}

      {pendingForceDelete &&
        createPortal(
          <AdminModal
            open
            compact
            title="Forzar eliminación"
            description="Esta compra ya tiene stock consumido por ventas posteriores."
            onClose={() => {
              if (!deletingId) setPendingForceDelete(null)
            }}
            footer={
              <div className="flex items-center justify-end gap-2">
                <AdminSecondaryButton
                  disabled={Boolean(deletingId)}
                  onClick={() => setPendingForceDelete(null)}
                >
                  Cancelar
                </AdminSecondaryButton>
                <AdminDangerButton
                  disabled={Boolean(deletingId)}
                  onClick={() => void confirmForceRemove()}
                >
                  {deletingId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {deletingId ? "Forzando…" : "Forzar eliminación"}
                </AdminDangerButton>
              </div>
            }
          >
            <p className="text-sm text-white/60">
              Como <span className="font-bold text-white">SUPER ADMIN</span> podés
              forzar la eliminación de todos modos: es una acción permanente y
              puede dejar el stock derivado en negativo.
            </p>
          </AdminModal>,
          document.body,
        )}
    </div>
  )
}
