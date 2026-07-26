"use client"

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  AlertTriangle,
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
import { formatPrice } from "../productos/helpers"
import { AdminDatePicker } from "../../components/admin-date-picker"

type CostMode = "product" | "expense"
type PurchaseSortKey =
  | "product"
  | "unitCost"
  | "subtotal"
  | "supplier"
  | "date"
  | "quantity"
type PurchaseSortDirection = "asc" | "desc"

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
  "Otros",
]

const PRODUCT_EXPENSE_CATEGORIES = new Set(["Donación/Regalo", "Sorteo/Evento"])

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
  const isUncatalogued = value === "custom"
  const normalizedSearch = search
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es")
  const filteredProducts = products.filter((product) =>
    (!inventoryMode || !product.standalone_key) &&
    `${product.nombre} ${product.sku ?? ""}`
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
        className={`${inputClass} flex cursor-pointer items-center justify-between gap-3 px-4 hover:bg-beyonix-blue/12 focus:border-beyonix-sky/55`}
      >
        <span className="size-4 shrink-0 text-beyonix-sky"><Boxes className="size-4" /></span>
        <span className={`min-w-0 flex-1 truncate ${selectedProduct || isUncatalogued ? "text-white" : "text-white/48"}`}>
          {isUncatalogued
            ? "Artículo no catalogado"
            : selectedVariant
              ? `${selectedProduct?.nombre} · ${selectedVariant.nombre}`
              : selectedProduct?.nombre ?? "Seleccionar producto"}
        </span>
        <ChevronDown className={`size-4 shrink-0 text-beyonix-sky transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-30 mt-2 max-h-280px overflow-y-auto rounded-2xl border border-beyonix-sky/28 bg-[#07131F] p-1.5 shadow-2xl shadow-black/60 custom-scrollbar">
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
              aria-selected={isUncatalogued}
              onClick={() => {
                onChange("custom")
                setOpen(false)
                setSearch("")
              }}
              className={`mb-1 flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left text-sm font-bold transition ${isUncatalogued ? "border-beyonix-sky/45 bg-beyonix-blue/55 text-white" : "border-beyonix-sky/20 text-beyonix-sky hover:bg-beyonix-blue/24"}`}
            >
              <span className="truncate">Artículo no catalogado</span>
              <Plus className="size-4 shrink-0" />
            </button>
          )}
          {filteredProducts.map((product) => {
            const productValue = optionValue(product)
            const active = productValue === value
            const hasVariants = Boolean(product.producto_variantes?.length)
            const availableStock = Number(product.stock ?? 0)
            const productDisabled =
              inventoryMode && (hasVariants || availableStock <= 0)
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
                    {inventoryMode
                      ? hasVariants
                        ? "Elegí una variante"
                        : `${availableStock} disponibles`
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
                      <span className="truncate">↳ {variant.nombre}</span>
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
  const productFormRef = useRef<HTMLElement>(null)
  const [data, setData] = useState<BusinessCostsData | null>(null)
  const [mode, setMode] = useState<CostMode>("product")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [purchaseSort, setPurchaseSort] = useState<PurchaseSortKey>("date")
  const [purchaseSortDirection, setPurchaseSortDirection] =
    useState<PurchaseSortDirection>("desc")
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [article, setArticle] = useState("")
  const [customArticleName, setCustomArticleName] = useState("")
  const [productSku, setProductSku] = useState("")
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
    const rows = [...(data?.productCosts ?? [])]
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
    purchaseSort,
    purchaseSortDirection,
  ])

  const purchaseSortDirectionOptions = useMemo(
    () =>
      purchaseSort === "product" || purchaseSort === "supplier"
        ? [
            { value: "desc", label: "Mayor a menor (Z–A)" },
            { value: "asc", label: "Menor a mayor (A–Z)" },
          ]
        : [
            { value: "desc", label: "Mayor a menor" },
            { value: "asc", label: "Menor a mayor" },
          ],
    [purchaseSort],
  )

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
    setEditingProductId(null)
    setArticle("")
    setCustomArticleName("")
    setProductSku("")
    setPurchaseDate(today())
    setQuantity("")
    setUnitCost("")
    setFreightCost("")
    setTaxCost("")
    setCommissionCost("")
    setOtherCost("")
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
    setCustomArticleName(item.article_name ?? "")
    setProductSku(item.sku ?? "")
    setPurchaseDate(item.purchase_date)
    setQuantity(String(item.quantity))
    setUnitCost(String(item.unit_cost))
    setFreightCost(Number(item.freight_cost) ? String(item.freight_cost) : "")
    setTaxCost(Number(item.tax_cost) ? String(item.tax_cost) : "")
    setCommissionCost(Number(item.commission_cost) ? String(item.commission_cost) : "")
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

  const saveProduct = async () => {
    const parts = article.split(":")
    const productId = parts[0] === "p" || parts[0] === "v" ? parts[1] : null
    const variantId = parts[0] === "v" ? parts[2] : null
    const standaloneProduct = data?.catalog.find(
      (product) => product.standalone_key && article === `c:${product.standalone_key}`,
    )
    const articleName =
      article === "custom"
        ? customArticleName.trim()
        : standaloneProduct?.nombre.trim() ?? ""

    if ((!productId && !articleName) || !purchaseDate || !quantity || !unitCost) {
      setError("Completá artículo, fecha, cantidad y costo unitario.")
      return
    }

    try {
      setSaving(true)
      setError("")
      setMessage("")
      const payload = {
        kind: "product",
        id: editingProductId,
        productId,
        variantId,
        articleName,
        sku: productSku,
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
      }
      if (editingProductId) {
        await updateBusinessCost(payload)
      } else {
        await createBusinessCost(payload)
      }
      const successMessage = editingProductId
        ? "Compra actualizada correctamente."
        : "Compra guardada correctamente."
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

    try {
      setSaving(true)
      setError("")
      setMessage("")
      await createBusinessCost({
        kind: "expense",
        expenseDate,
        category: expenseCategory,
        expenseType,
        productId: expenseProductId,
        variantId: expenseVariantId,
        productSku: selectedExpenseProduct?.sku ?? "",
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
      })
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

  const remove = async (kind: CostMode, id: string) => {
    const restoresInventory =
      kind === "expense" &&
      data?.expenses.some((item) => item.id === id && item.expense_type === "product")
    const confirmation = restoresInventory
      ? "¿Querés eliminar esta salida? Las unidades se reintegrarán al stock."
      : "¿Querés eliminar este movimiento?"
    if (!window.confirm(confirmation)) return
    try {
      setError("")
      await deleteBusinessCost(kind, id)
      if (kind === "product" && editingProductId === id) resetProductForm()
      await load()
      onChanged?.()
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
          <section ref={productFormRef} className="scroll-mt-4 rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2">
              {editingProductId ? <Pencil className="size-4 text-beyonix-sky" /> : <Plus className="size-4 text-beyonix-sky" />}
              <h3 className="text-base font-black text-white">{editingProductId ? "Editar compra" : "Nueva compra"}</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Artículo" className="xl:col-span-2">
                <ProductSelect
                  value={article}
                  products={data?.catalog ?? []}
                  onChange={(value) => {
                    setArticle(value)
                    if (value === "custom") {
                      setCustomArticleName(latestArticleBase)
                    } else {
                      setCustomArticleName("")
                    }
                    const selectedProduct = data?.catalog.find(
                      (product) =>
                        value ===
                        (product.standalone_key
                          ? `c:${product.standalone_key}`
                          : `p:${product.id}`),
                    )
                    setProductSku(selectedProduct?.sku ?? "")
                  }}
                />
              </Field>
              {article === "custom" && (
                <Field label="Nombre del artículo" className="md:col-span-2 xl:col-span-2">
                  <HistoryAutocompleteInput
                    value={customArticleName}
                    suggestions={articleNameSuggestions}
                    onChange={setCustomArticleName}
                    placeholder="Ej. cajas para envíos"
                    maxLength={180}
                    autoFocus
                  />
                </Field>
              )}
              <Field label="SKU">
                <input
                  value={productSku}
                  onChange={(event) => setProductSku(event.target.value)}
                  className={inputClass}
                  placeholder="Ej. TRI-360"
                  maxLength={120}
                />
              </Field>
              <Field label="Fecha compra"><AdminDatePicker title="Fecha compra" ariaLabel="Fecha de compra" value={purchaseDate} onChange={setPurchaseDate} centered /></Field>
              <Field label="Cantidad"><input value={quantity} inputMode="numeric" onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ""))} className={inputClass} placeholder="0" /></Field>
              <Field label="Costo unitario"><MoneyInput value={unitCost} onChange={setUnitCost} /></Field>
              <Field label="Proveedor"><HistoryAutocompleteInput value={productSupplier} suggestions={supplierSuggestions} onChange={setProductSupplier} placeholder="Opcional" /></Field>
              <Field label="Flete"><MoneyInput value={freightCost} onChange={setFreightCost} /></Field>
              <Field label="Impuestos"><MoneyInput value={taxCost} onChange={setTaxCost} /></Field>
              <Field label="Comisiones"><MoneyInput value={commissionCost} onChange={setCommissionCost} /></Field>
              <Field label="Otros costos"><MoneyInput value={otherCost} onChange={setOtherCost} /></Field>
              <Field label="Comprobante"><input value={productDocumentType} onChange={(event) => setProductDocumentType(event.target.value)} className={inputClass} placeholder="Factura, recibo" /></Field>
              <Field label="Número"><input value={productDocumentNumber} onChange={(event) => setProductDocumentNumber(event.target.value)} className={inputClass} placeholder="Opcional" /></Field>
              <Field label="Medio pago"><HistoryAutocompleteInput value={productPaymentMethod} suggestions={paymentMethodSuggestions} onChange={setProductPaymentMethod} placeholder="Transferencia" /></Field>
              <Field label="Notas" className="xl:col-span-2"><HistoryAutocompleteInput value={productNotes} suggestions={notesSuggestions} onChange={setProductNotes} placeholder="Detalle adicional" /></Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              {editingProductId && (
                <button type="button" disabled={saving} onClick={resetProductForm} className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/15 px-4 text-sm font-black text-white/65 transition hover:border-white/30 hover:text-white disabled:opacity-50">
                  <X className="size-4" /> Cancelar
                </button>
              )}
              <button type="button" disabled={saving} onClick={() => void saveProduct()} className="inline-flex h-10 min-w-130px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/35 bg-beyonix-blue/38 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/60 hover:bg-beyonix-blue/55 disabled:cursor-wait disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {editingProductId ? "Actualizar" : "Guardar"}</button>
            </div>
          </section>

          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
              <h3 className="text-base font-black text-white">
                Historial de compras
              </h3>
              <div className="flex flex-wrap items-center justify-center gap-2 justify-self-center">
                <div className="flex items-center rounded-xl border border-beyonix-blue-light/18 bg-black/22 p-1.5 pl-2.5">
                  <span className="mr-2 whitespace-nowrap text-10px font-black uppercase tracking-wider text-white/42">
                    Ordenar por:
                  </span>
                  <div className="w-180px">
                    <ModernSelect
                      ariaLabel="Ordenar historial de compras por"
                      value={purchaseSort}
                      onChange={(value) =>
                        setPurchaseSort(value as PurchaseSortKey)
                      }
                      options={[
                        { value: "product", label: "Producto" },
                        { value: "unitCost", label: "Precio unitario" },
                        { value: "subtotal", label: "Subtotal" },
                        { value: "supplier", label: "Proveedor" },
                        { value: "date", label: "Fecha" },
                        { value: "quantity", label: "Cantidad" },
                      ]}
                      compact
                      centered
                    />
                  </div>
                </div>
                <div className="flex items-center rounded-xl border border-beyonix-blue-light/18 bg-black/22 p-1.5 pl-2.5">
                  <span className="mr-2 whitespace-nowrap text-10px font-black uppercase tracking-wider text-white/42">
                    Dirección:
                  </span>
                  <div className="w-190px">
                    <ModernSelect
                      ariaLabel="Dirección del orden del historial de compras"
                      value={purchaseSortDirection}
                      onChange={(value) =>
                        setPurchaseSortDirection(
                          value === "asc" ? "asc" : "desc",
                        )
                      }
                      options={purchaseSortDirectionOptions}
                      compact
                      centered
                    />
                  </div>
                </div>
              </div>
              <span className="text-xs font-bold text-white/38 md:justify-self-end">
                {data?.productCosts.length ?? 0} registros
              </span>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-white/7">
              <table className="w-full min-w-1100px text-sm"><thead className="bg-black/30 text-10px uppercase tracking-widest text-white/42"><tr><th className="px-3 py-2.5 text-center">Fecha</th><th className="px-3 py-2.5 text-left">Artículo</th><th className="px-3 py-2.5 text-center">SKU</th><th className="px-3 py-2.5 text-center">Cantidad</th><th className="px-3 py-2.5 text-center">Unitario</th><th className="px-3 py-2.5 text-center">Extras</th><th className="px-3 py-2.5 text-center">Total</th><th className="px-3 py-2.5 text-center">Proveedor</th><th className="px-3 py-2.5 text-center">Acción</th></tr></thead>
                <tbody>{sortedProductCosts.map((item) => { const articleLabel = getProductCostName(item); const extras = Number(item.freight_cost) + Number(item.tax_cost) + Number(item.commission_cost) + Number(item.other_cost); return <tr key={item.id} className="border-t border-white/6 text-white/65"><td className="px-3 py-3 text-center">{item.purchase_date}</td><td className="px-3 py-3 text-left font-bold text-white">{articleLabel}</td><td className="px-3 py-3 text-center font-semibold text-white/55">{item.sku || "—"}</td><td className="px-3 py-3 text-center tabular-nums">{item.quantity}</td><td className="px-3 py-3 text-center tabular-nums">{formatPrice(Number(item.unit_cost))}</td><td className="px-3 py-3 text-center tabular-nums">{formatPrice(extras)}</td><td className="px-3 py-3 text-center font-black tabular-nums text-white">{formatPrice(Number(item.total_cost))}</td><td className="px-3 py-3 text-center">{item.supplier || "—"}</td><td className="px-3 py-3"><div className="flex items-center justify-center gap-1.5"><button type="button" aria-label="Editar compra" onClick={() => editProduct(item)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-beyonix-sky/30 text-beyonix-sky transition hover:bg-beyonix-sky/10"><Pencil className="size-3.5" /></button><button type="button" aria-label="Eliminar compra" onClick={() => void remove("product", item.id)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/25 text-red-300 transition hover:bg-red-400/10"><Trash2 className="size-3.5" /></button></div></td></tr>})}</tbody>
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
              <Field label="Categoría"><ModernSelect value={expenseCategory} onChange={(category) => {
                setExpenseCategory(category)
                if (category !== "Otros") setExpenseCategoryDetail("")
                if (category !== "Donación/Regalo") setExpenseRecipient("")
                if (!PRODUCT_EXPENSE_CATEGORIES.has(category)) {
                  setExpenseType("money")
                  setExpenseProduct("")
                  setExpenseProductQuantity("")
                }
              }} options={EXPENSE_CATEGORIES.map((category) => ({ value: category, label: category }))} /></Field>
              {PRODUCT_EXPENSE_CATEGORIES.has(expenseCategory) && (
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

          <section className="rounded-3xl border border-beyonix-blue-light/16 bg-[#071018] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-base font-black text-white">Historial de gastos</h3><span className="text-xs font-bold text-white/38">{data?.expenses.length ?? 0} registros</span></div>
            <div className="overflow-x-auto rounded-2xl border border-white/7">
              <table className="w-full min-w-1000px text-sm"><thead className="bg-black/30 text-10px uppercase tracking-widest text-white/42"><tr><th className="px-3 py-2.5 text-left">Fecha</th><th className="px-3 py-2.5 text-left">Categoría</th><th className="px-3 py-2.5 text-left">Descripción</th><th className="px-3 py-2.5 text-right">Importe</th><th className="px-3 py-2.5 text-center">Estado</th><th className="px-3 py-2.5 text-center">Frecuencia</th><th className="px-3 py-2.5 text-left">Proveedor</th><th className="px-3 py-2.5 text-center">Acción</th></tr></thead>
                <tbody>{data?.expenses.map((item) => <tr key={item.id} className="border-t border-white/6 text-white/65"><td className="px-3 py-3">{item.expense_date}</td><td className="px-3 py-3"><span className="font-bold text-white">{item.category}</span>{item.recipient && <span className="mt-0.5 block text-xs text-white/48">Dirigido a: {item.recipient}</span>}{item.category_detail && <span className="mt-0.5 block text-xs text-white/48">{item.category_detail}</span>}{item.expense_type === "product" && <span className="mt-1 block text-xs font-bold text-beyonix-sky">{item.quantity} × {item.product_name}{item.product_sku ? ` · ${item.product_sku}` : ""}</span>}</td><td className="px-3 py-3">{item.description || "—"}</td><td className="px-3 py-3 text-right font-black tabular-nums text-white">{item.expense_type === "product" ? <span className="text-xs text-beyonix-sky">Salida de stock</span> : formatPrice(Number(item.amount))}</td><td className="px-3 py-3 text-center"><span className={`rounded-full border px-2.5 py-1 text-xs font-black ${item.status === "pagado" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>{item.expense_type === "product" ? "Registrado" : item.status === "pagado" ? "Pagado" : "Pendiente"}</span></td><td className="px-3 py-3 text-center capitalize">{item.recurrence}</td><td className="px-3 py-3">{item.supplier || "—"}</td><td className="px-3 py-3 text-center"><button type="button" aria-label="Eliminar gasto" onClick={() => void remove("expense", item.id)} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/25 text-red-300 transition hover:bg-red-400/10"><Trash2 className="size-3.5" /></button></td></tr>)}</tbody>
              </table>
              {!data?.expenses.length && <p className="px-4 py-8 text-center text-sm text-white/42">Todavía no registraste gastos.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
