"use client"

import { useState } from "react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import { useCategorias } from "@/hooks/use-categorias"

import { CategoriasToolbar } from "./categorias-toolbar"
import { CategoriasTable } from "./categorias-table"
import { CategoriaForm } from "./categorias-form"

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function AdminCategorias() {
  const {
    categorias,
    loading,
    deleteCategoria,
    reloadCategorias,
  } = useCategorias()

  const [search, setSearch] =
    useState("")

  const [editando, setEditando] =
    useState<
      SupabaseCategoria | null | undefined
    >(undefined)

  // undefined = cerrado
  // null = nueva categoría
  // categoría = edición

  // ───────────────────────────────────────────────────────────────────────────
  // Search
  // ───────────────────────────────────────────────────────────────────────────

  const categoriasFiltradas =
    categorias.filter((c) =>
      c.nombre
        .toLowerCase()
        .includes(
          search.toLowerCase()
        )
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Delete
  // ───────────────────────────────────────────────────────────────────────────

  const handleDelete = async (
    id: number
  ) => {
    const ok = confirm(
      "¿Eliminar esta categoría?"
    )

    if (!ok) return

    await deleteCategoria(id)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Saved
  // ───────────────────────────────────────────────────────────────────────────

  const handleSaved = async () => {
    await reloadCategorias()

    setEditando(undefined)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Form abierto
  // ───────────────────────────────────────────────────────────────────────────

  if (editando !== undefined) {
    return (
      <CategoriaForm
        categoria={editando}
        onSaved={handleSaved}
        onCancel={() =>
          setEditando(undefined)
        }
      />
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-8">
      <CategoriasToolbar
        search={search}
        onSearchChange={setSearch}
        onCreate={() =>
          setEditando(null)
        }
      />

      <CategoriasTable
        categorias={
          categoriasFiltradas
        }
        loading={loading}
        onEdit={(categoria) =>
          setEditando(categoria)
        }
        onDelete={handleDelete}
      />
    </div>
  )
}