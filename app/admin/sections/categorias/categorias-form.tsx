"use client"

import { useState } from "react"

import {
  ArrowLeft,
  Loader2,
} from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import {
  createCategoria,
  updateCategoria,
} from "@/lib/supabase/queries/categorias"

import { slugify } from "../productos/helpers"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface CategoriaFormProps {
  categoria?: SupabaseCategoria | null

  onSaved: () => void

  onCancel: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface CategoriaFormState {
  nombre: string
  slug: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function CategoriaForm({
  categoria,
  onSaved,
  onCancel,
}: CategoriaFormProps) {
  const [saving, setSaving] =
    useState(false)

  const [error, setError] =
    useState("")

  const [form, setForm] =
    useState<CategoriaFormState>({
      nombre:
        categoria?.nombre ?? "",

      slug:
        categoria?.slug ?? "",
    })

  // ───────────────────────────────────────────────────────────────────────────
  // Set helper
  // ───────────────────────────────────────────────────────────────────────────

  const set = <
    K extends keyof CategoriaFormState
  >(
    key: K,
    value: CategoriaFormState[K]
  ) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }))
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Nombre change
  // ───────────────────────────────────────────────────────────────────────────

  const handleNombreChange = (
    value: string
  ) => {
    set("nombre", value)

    if (!categoria) {
      set(
        "slug",
        slugify(value)
      )
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Submit
  // ───────────────────────────────────────────────────────────────────────────

  const handleSubmit = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setError("")

    if (!form.nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    try {
      setSaving(true)

      const payload = {
        nombre:
          form.nombre.trim(),

        slug:
          form.slug.trim() ||
          slugify(form.nombre),
      }

      // Editar
      if (categoria) {
        await updateCategoria(
          categoria.id,
          payload
        )
      }

      // Crear
      else {
        await createCategoria(
          payload
        )
      }

      onSaved()
    } catch (err) {
      console.error(err)

      setError(
        "Ocurrió un error guardando la categoría."
      )
    } finally {
      setSaving(false)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Styles
  // ───────────────────────────────────────────────────────────────────────────

  const inputCls =
    "w-full bg-[#0A0A0A] border border-white/8 rounded-2xl px-4 py-3 text-sm text-white placeholder:text-white/25 outline-none focus:border-[#1E4D7B] transition-colors"

  const labelCls =
    "block text-xs font-semibold uppercase tracking-[0.15em] text-white/40 mb-2"

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
            Categorías
          </p>

          <h1 className="text-3xl font-bold text-white">
            {categoria
              ? "Editar categoría"
              : "Nueva categoría"}
          </h1>
        </div>

        <button
          type="button"
          title="Volver"
          onClick={onCancel}
          className="h-11 px-4 rounded-2xl border border-white/8 text-white/60 hover:text-white transition-colors inline-flex items-center gap-2 cursor-pointer"
        >
          <ArrowLeft className="size-4" />
          Volver
        </button>
      </div>

      {/* Card */}
      <div className="rounded-3xl border border-white/7 bg-[#0A0A0A] p-6">
        <form
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          {/* Nombre */}
          <div>
            <label
              htmlFor="nombre-categoria-input"
              className={labelCls}
            >
              Nombre *
            </label>

            <input
              id="nombre-categoria-input"
              type="text"
              title="Nombre categoría"
              placeholder="Auriculares..."
              className={inputCls}
              value={form.nombre}
              onChange={(e) =>
                handleNombreChange(
                  e.target.value
                )
              }
            />
          </div>

          {/* Slug */}
          <div>
            <label
              htmlFor="slug-categoria-input"
              className={labelCls}
            >
              Slug
            </label>

            <input
              id="slug-categoria-input"
              type="text"
              title="Slug categoría"
              placeholder="auriculares..."
              className={inputCls}
              value={form.slug}
              onChange={(e) =>
                set(
                  "slug",
                  e.target.value
                )
              }
            />
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
              <p className="text-sm text-red-400">
                {error}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              title="Guardar categoría"
              className="flex-1 h-12 rounded-2xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all cursor-pointer"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin mx-auto" />
              ) : categoria ? (
                "Guardar cambios"
              ) : (
                "Crear categoría"
              )}
            </button>

            <button
              type="button"
              title="Cancelar"
              onClick={onCancel}
              className="h-12 px-6 rounded-2xl border border-white/10 text-sm text-white/60 hover:text-white transition-colors cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}