"use client"

import { useState } from "react"
import { ArrowLeft, Loader2, ToggleLeft, ToggleRight } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import type {
  DraftProductoEspecificacion,
  DraftProductoVariante,
} from "./types"
import { ProductSpecificationsEditor } from "./product-specifications-editor"
import { ProductVariantsEditor } from "./product-variants-editor"
import { useProductoForm } from "./use-producto-form"
import { AdminSelect } from "../../components/admin-controls"

interface ProductoFormProps {
  producto?: SupabaseProducto | null
  onSaved: () => void
  onCancel: () => void
}

const inputCls =
  "w-full rounded-2xl border border-white/8 bg-black px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-blue-light"

const labelCls =
  "mb-2 block text-xs font-semibold uppercase tracking-widest text-white/50"

export function ProductoForm({ producto, onSaved, onCancel }: ProductoFormProps) {
  const [draftVariants, setDraftVariants] = useState<DraftProductoVariante[]>([])
  const [
    draftSpecifications,
    setDraftSpecifications,
  ] = useState<DraftProductoEspecificacion[]>([])

  const {
    form,
    error,
    success,
    saving,
    savedId,
    categorias,
    setField,
    submit,
    handleNombreChange,
  } = useProductoForm({
    producto,
    onSaved,
  })

  const currentProductoId = producto?.id || savedId

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Productos
            </p>
            <h1 className="text-3xl font-bold text-white">
              {producto ? "Editar producto" : "Nuevo producto"}
            </h1>
          </div>

          <button
            type="button"
            title="Volver"
            aria-label="Volver"
            onClick={onCancel}
            className="inline-flex h-12 min-w-140px items-center justify-center gap-2 rounded-2xl border border-white/8 px-6 text-white/70 transition-colors hover:text-white cursor-pointer"
          >
            <ArrowLeft className="size-4" />
            Volver
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit({
              draftVariants,
              draftSpecifications,
              onDraftSaved: () => {
                setDraftVariants([])
                setDraftSpecifications([])
              },
            })
          }}
          className="rounded-3xl border border-white/7 bg-black p-5 shadow-2xl shadow-black/30 sm:p-6"
        >
          <div className="grid gap-6 xl:grid-cols-admin-product-form xl:items-start">
            <section className="space-y-4 rounded-2xl border border-white/7 bg-black p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="nombre" className={labelCls}>
                    Nombre *
                  </label>
                  <input
                    id="nombre"
                    type="text"
                    title="Nombre"
                    value={form.nombre}
                    placeholder="Auriculares..."
                    onChange={(event) => handleNombreChange(event.target.value)}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label htmlFor="slug" className={labelCls}>
                    Slug
                  </label>
                  <input
                    id="slug"
                    type="text"
                    title="Slug"
                    value={form.slug}
                    placeholder="auriculares..."
                    onChange={(event) => setField("slug", event.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="descripcion" className={labelCls}>
                  Descripcion
                </label>
                <textarea
                  id="descripcion"
                  title="Descripcion"
                  value={form.descripcion}
                  placeholder="Descripcion del producto..."
                  onChange={(event) => setField("descripcion", event.target.value)}
                  className={`${inputCls} min-h-112px resize-none leading-6`}
                />
                <p className="mt-2 text-xs leading-5 text-white/45">
                  La descripcion debe ser un texto breve y vendedor. Las caracteristicas tecnicas van en Especificaciones.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="precio" className={labelCls}>
                    Precio
                  </label>
                  <input
                    min="0"
                    type="number"
                    id="precio"
                    title="Precio"
                    placeholder="0"
                    value={form.precio}
                    onChange={(event) => setField("precio", event.target.value)}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label htmlFor="precio_anterior" className={labelCls}>
                    Precio anterior
                  </label>
                  <input
                    min="0"
                    type="number"
                    id="precio_anterior"
                    title="Precio anterior"
                    placeholder="0"
                    value={form.precio_anterior}
                    onChange={(event) =>
                      setField("precio_anterior", event.target.value)
                    }
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="cuotas" className={labelCls}>
                  Cuotas sin interes
                </label>
                <AdminSelect
                  title="Cuotas sin interes"
                  value={form.cuotas}
                  onChange={(value) => setField("cuotas", value)}
                >
                  <option value="sin_cuotas">Sin cuotas</option>
                  <option value="3">3 cuotas sin interes</option>
                  <option value="6">6 cuotas sin interes</option>
                </AdminSelect>
              </div>

              <div>
                <label htmlFor="categoria" className={labelCls}>
                  Categoria
                </label>
                <AdminSelect
                  title="Categoria"
                  value={form.categoria_id}
                  onChange={(value) => setField("categoria_id", value)}
                >
                  <option value="">Sin categoria</option>
                  {categorias.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.nombre}
                    </option>
                  ))}
                </AdminSelect>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    key: "destacado" as const,
                    label: "Producto destacado",
                    active: form.destacado,
                    color: "text-beyonix-cyan",
                  },
                  {
                    key: "activo" as const,
                    label: form.activo ? "Producto activo" : "Producto inactivo",
                    active: form.activo,
                    color: "text-green-400",
                  },
                ].map((toggle) => (
                  <button
                    key={toggle.key}
                    type="button"
                    title={toggle.label}
                    aria-label={toggle.label}
                    onClick={() => setField(toggle.key, !toggle.active)}
                    className="flex min-h-48px items-center gap-3 rounded-2xl border border-white/8 bg-black px-4 text-left transition-colors hover:border-beyonix-blue-light/45 cursor-pointer"
                  >
                    {toggle.active ? (
                      <ToggleRight className={`size-6 ${toggle.color}`} />
                    ) : (
                      <ToggleLeft className="size-6 text-white/45" />
                    )}
                    <span className="text-sm text-white/80">{toggle.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-6">
              <div>
                <label className={labelCls}>Variantes</label>
                <ProductVariantsEditor
                  productoId={currentProductoId || undefined}
                  draftVariants={draftVariants}
                  onDraftVariantsChange={setDraftVariants}
                />
              </div>

              <div>
                <label className={labelCls}>Especificaciones</label>
                <ProductSpecificationsEditor
                  productoId={currentProductoId || undefined}
                  draftSpecifications={draftSpecifications}
                  onDraftSpecificationsChange={setDraftSpecifications}
                />
              </div>
            </section>
          </div>

          <div className="mt-5 space-y-4">
            {error && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {success && (
              <div className="rounded-2xl border border-green-500/20 bg-green-500/8 px-4 py-3">
                <p className="text-sm text-green-300">{success}</p>
              </div>
            )}

            <div className="flex gap-3 border-t border-white/7 pt-5">
              <button
                type="submit"
                disabled={saving}
                title="Guardar producto"
                aria-label="Guardar producto"
                className="flex h-12 flex-1 items-center justify-center rounded-2xl bg-white px-6 text-sm font-semibold text-black transition-all hover:bg-white/90 disabled:opacity-50 cursor-pointer"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : producto ? (
                  "Guardar cambios"
                ) : savedId ? (
                  "Finalizar producto"
                ) : (
                  "Crear producto"
                )}
              </button>

              <button
                type="button"
                title="Cancelar"
                aria-label="Cancelar"
                onClick={onCancel}
                className="h-12 min-w-140px rounded-2xl border border-white/10 px-6 text-sm text-white/70 transition-colors hover:text-white cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
