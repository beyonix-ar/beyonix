"use client"

import { useState } from "react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { useProductos } from "@/hooks/use-productos"

import { ProductosToolbar } from "./productos-toolbar"
import { ProductosTable } from "./productos-table"
import { ProductoForm } from "./producto-form"

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function AdminProductos() {
  const {
    productos,
    loading,
    deleteProducto,
    toggleProductoActivo,
    reloadProductos,
  } = useProductos()

  const [search, setSearch] =
    useState("")

  const [editando, setEditando] =
    useState<
      SupabaseProducto | null | undefined
    >(undefined)

  // undefined = cerrado
  // null = nuevo producto
  // producto = edición

  // ───────────────────────────────────────────────────────────────────────────
  // Search
  // ───────────────────────────────────────────────────────────────────────────

  const productosFiltrados =
    productos.filter((p) =>
      p.nombre
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
      "¿Eliminar este producto?"
    )

    if (!ok) return

    await deleteProducto(id)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Toggle activo
  // ───────────────────────────────────────────────────────────────────────────

  const handleToggleActivo =
    async (
      producto: SupabaseProducto
    ) => {
      await toggleProductoActivo(
        producto
      )
    }

  // ───────────────────────────────────────────────────────────────────────────
  // Saved
  // ───────────────────────────────────────────────────────────────────────────

  const handleSaved = async () => {
    await reloadProductos()

    setEditando(undefined)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Form abierto
  // ───────────────────────────────────────────────────────────────────────────

  if (editando !== undefined) {
    return (
      <ProductoForm
        producto={editando}
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
      <ProductosToolbar
        search={search}
        onSearchChange={setSearch}
        onCreate={() =>
          setEditando(null)
        }
      />

      <ProductosTable
        productos={
          productosFiltrados
        }
        loading={loading}
        onEdit={(producto) =>
          setEditando(producto)
        }
        onDelete={handleDelete}
        onToggleActivo={
          handleToggleActivo
        }
      />
    </div>
  )
}