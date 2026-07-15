"use client"

import { useEffect, useState } from "react"
import {
  BadgePercent,
  Check,
  CheckCircle2,
  Package,
  RotateCcw,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react"

import {
  AdminButton,
  AdminFormField,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSection,
  AdminSelect,
  AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseCategoria, SupabaseProducto } from "@/lib/supabase/types"

type BulkScope = "store" | "category" | "product"
type BulkActionKind =
  | "discount_percent"
  | "price_decrease_percent"
  | "price_increase_percent"
  | "installments"
  | "clear_offer"

type TargetItem = {
  type: "category" | "product"
  label: string
  url: string
}

type CategoryOption = Pick<SupabaseCategoria, "id" | "nombre" | "slug">
type ProductOption = Pick<SupabaseProducto, "id" | "nombre" | "slug" | "activo">

const ACTION_OPTIONS: Array<{
  value: BulkActionKind
  label: string
  help: string
}> = [
  {
    value: "discount_percent",
    label: "Descuento especial",
    help: "Baja el precio y guarda el precio anterior para mostrar el % OFF.",
  },
  {
    value: "price_decrease_percent",
    label: "Baja de precio",
    help: "Reduce precios en porcentaje y deja visible el precio anterior.",
  },
  {
    value: "price_increase_percent",
    label: "Aumento de precio",
    help: "Aumenta precios en porcentaje y limpia descuentos previos.",
  },
  {
    value: "installments",
    label: "Cuotas sin interés",
    help: "Activa 3 o 6 cuotas sin interés en los productos alcanzados.",
  },
  {
    value: "clear_offer",
    label: "Quitar oferta",
    help: "Limpia descuentos, precio anterior y cuotas especiales.",
  },
]

const PERCENT_ACTIONS: BulkActionKind[] = [
  "discount_percent",
  "price_decrease_percent",
  "price_increase_percent",
]

async function getAdminToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token ?? ""
}

export function AdminAccionesMasivas() {
  const [scope, setScope] = useState<BulkScope>("product")
  const [actionKind, setActionKind] = useState<BulkActionKind>("discount_percent")
  const [value, setValue] = useState("10")
  const [installments, setInstallments] = useState("3")
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [targetItems, setTargetItems] = useState<TargetItem[]>([])
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [error, setError] = useState("")

  const selectedAction = ACTION_OPTIONS.find((item) => item.value === actionKind)
  const isPercentAction = PERCENT_ACTIONS.includes(actionKind)

  useEffect(() => {
    let active = true

    async function loadCatalog() {
      const [categoriesResult, productsResult] = await Promise.all([
        supabase.from("categorias").select("id, nombre, slug").order("nombre"),
        supabase.from("productos").select("id, nombre, slug, activo").order("nombre"),
      ])

      if (!active) return

      const nextCategories = (categoriesResult.data ?? []) as CategoryOption[]
      const nextProducts = (productsResult.data ?? []) as ProductOption[]

      setCategories(nextCategories)
      setProducts(nextProducts)
    }

    void loadCatalog()

    return () => {
      active = false
    }
  }, [])

  const setNextScope = (value: string) => {
    setScope(value as BulkScope)
    setTargetItems([])
  }

  const getProductTargetItem = (product: ProductOption): TargetItem => ({
    type: "product",
    label: product.nombre,
    url: `/productos/${product.slug}`,
  })

  const getCategoryTargetItem = (category: CategoryOption): TargetItem => ({
    type: "category",
    label: category.nombre,
    url: `/categorias/${category.slug}`,
  })

  const toggleProduct = (product: ProductOption) => {
    const item = getProductTargetItem(product)

    setTargetItems((current) =>
      current.some((target) => target.url === item.url)
        ? current.filter((target) => target.url !== item.url)
        : [...current, item],
    )
  }

  const toggleCategory = (category: CategoryOption) => {
    const item = getCategoryTargetItem(category)

    setTargetItems((current) =>
      current.some((target) => target.url === item.url)
        ? current.filter((target) => target.url !== item.url)
        : [...current, item],
    )
  }

  const applyBulkAction = async () => {
    setSaving(true)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-actions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scope,
          target_items: targetItems,
          action_kind: actionKind,
          value: Number(value),
          installments: Number(installments),
        }),
      })
      const data = (await response.json()) as {
        affectedCount?: number
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo aplicar la acción masiva.")
      }

      setFeedback(`Acción aplicada sobre ${data.affectedCount ?? 0} productos.`)
    } catch (applyError) {
      setError(
        applyError instanceof Error ? applyError.message : "No se pudo aplicar la acción masiva.",
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Comercial"
        title="Editor masivo"
        description="Aplicá descuentos, aumentos, bajas de precio o cuotas sin interés a muchos productos sin editarlos uno por uno."
      />

      {(feedback || error) && (
        <AdminInfoBlock tone={error ? "danger" : "success"}>
          {error || feedback}
        </AdminInfoBlock>
      )}

      <AdminSection eyebrow="Regla" title="Acción masiva" className="p-3 sm:p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(280px,420px)_minmax(320px,1fr)]">
          <div className="grid content-start gap-3">
            <AdminFormField label="Alcance">
              <AdminSelect title="Alcance" value={scope} onChange={setNextScope}>
                <option value="product">Productos seleccionados</option>
                <option value="category">Categorías seleccionadas</option>
                <option value="store">Toda la tienda</option>
              </AdminSelect>
            </AdminFormField>

            <AdminFormField label="Acción comercial" help={selectedAction?.help}>
              <AdminSelect
                title="Acción comercial"
                value={actionKind}
                onChange={(nextValue) => setActionKind(nextValue as BulkActionKind)}
              >
                {ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </AdminSelect>
            </AdminFormField>

            {isPercentAction && (
              <AdminFormField label="Porcentaje" className="max-w-[220px]">
                <AdminTextInput
                  title="Porcentaje"
                  type="number"
                  inputMode="numeric"
                  placeholder="10"
                  value={value}
                  onChange={setValue}
                />
              </AdminFormField>
            )}

            {actionKind === "installments" && (
              <AdminFormField label="Cuotas">
                <AdminSelect title="Cuotas" value={installments} onChange={setInstallments}>
                  <option value="3">3 cuotas sin interés</option>
                  <option value="6">6 cuotas sin interés</option>
                </AdminSelect>
              </AdminFormField>
            )}

            {scope !== "store" && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-11px font-black uppercase tracking-widest text-white/48">
                    Selección
                  </p>
                  {targetItems.length > 0 && (
                    <span className="rounded-full border border-beyonix-blue-light/18 bg-beyonix-blue/12 px-2 py-0.5 text-10px uppercase tracking-widest text-beyonix-sky/80">
                      {targetItems.length} seleccionados
                    </span>
                  )}
                </div>
                {targetItems.length ? (
                  <div className="beyonix-product-picker-scroll flex max-h-[58px] min-h-[44px] flex-wrap items-center gap-1.5 overflow-y-auto rounded-lg border border-beyonix-blue-light/14 bg-black/12 px-2 py-1.5 pr-2.5">
                    {targetItems.map((item) => (
                      <span
                        key={item.url}
                        className="group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-beyonix-blue-light/20 bg-[#0d2236] px-2 text-11px font-medium text-white/86 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-beyonix-sky/38 hover:bg-[#12365a]"
                      >
                        <span className="max-w-28 truncate sm:max-w-36">{item.label}</span>
                        <button
                          type="button"
                          aria-label={`Quitar ${item.label}`}
                          onClick={() =>
                            setTargetItems((current) =>
                              current.filter((target) => target.url !== item.url),
                            )
                          }
                          className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-white/38 transition hover:text-red-300"
                        >
                          <X className="size-2.5" strokeWidth={2.4} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-2 text-sm text-white/45">
                    Agregá al menos un elemento.
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <AdminPrimaryButton
                size="sm"
                icon={
                  actionKind === "price_increase_percent" ? (
                    <TrendingUp className="size-3.5" />
                  ) : actionKind === "price_decrease_percent" ? (
                    <TrendingDown className="size-3.5" />
                  ) : actionKind === "installments" ? (
                    <CheckCircle2 className="size-3.5" />
                  ) : actionKind === "clear_offer" ? (
                    <RotateCcw className="size-3.5" />
                  ) : (
                    <BadgePercent className="size-3.5" />
                  )
                }
                disabled={saving}
                className="h-9 min-h-0 px-3 py-0 text-xs font-medium"
                onClick={() => void applyBulkAction()}
              >
                {saving ? "Aplicando" : "Aplicar acción"}
              </AdminPrimaryButton>
              <AdminButton
                size="sm"
                icon={<Package className="size-3.5" />}
                className="h-9 min-h-0 px-3 py-0 text-xs font-medium"
                onClick={() => setTargetItems([])}
              >
                Limpiar selección
              </AdminButton>
            </div>
          </div>

          <div className="flex min-h-80 flex-col rounded-2xl border border-beyonix-blue-light/14 bg-black/12 p-3">
            {scope === "product" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                  Productos
                </p>
                <div className="beyonix-product-picker-scroll min-h-0 flex-1 overflow-y-scroll rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5 pr-2">
                  {products.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-white/45">
                      No hay productos disponibles para seleccionar.
                    </div>
                  ) : (
                    products.map((product) => {
                      const item = getProductTargetItem(product)
                      const checked = targetItems.some((target) => target.url === item.url)

                      return (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => toggleProduct(product)}
                          className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#1E4D7B]/32"
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded border transition ${
                              checked
                                ? "border-beyonix-sky bg-beyonix-sky text-[#06111d] shadow-[0_0_0_2px_rgba(140,200,242,0.12)]"
                                : "border-beyonix-blue-light/36 bg-[#07111d]"
                            }`}
                          >
                            {checked && <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-white/86">
                              {product.nombre}
                            </span>
                            {!product.activo && (
                              <span className="mt-0.5 block text-11px text-amber-200/70">
                                Producto inactivo
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {scope === "category" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                  Categorías
                </p>
                <div className="beyonix-product-picker-scroll min-h-0 flex-1 overflow-y-scroll rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5 pr-2">
                  {categories.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-white/45">
                      No hay categorías disponibles para seleccionar.
                    </div>
                  ) : (
                    categories.map((category) => {
                      const item = getCategoryTargetItem(category)
                      const checked = targetItems.some((target) => target.url === item.url)

                      return (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() => toggleCategory(category)}
                          className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#1E4D7B]/32"
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded border transition ${
                              checked
                                ? "border-beyonix-sky bg-beyonix-sky text-[#06111d] shadow-[0_0_0_2px_rgba(140,200,242,0.12)]"
                                : "border-beyonix-blue-light/36 bg-[#07111d]"
                            }`}
                          >
                            {checked && <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span className="block truncate text-xs font-medium text-white/86">
                            {category.nombre}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {scope === "store" && (
              <div className="rounded-xl border border-emerald-300/18 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100/80">
                La acción se aplicará sobre toda la tienda.
              </div>
            )}
          </div>
        </div>
      </AdminSection>
    </div>
  )
}
