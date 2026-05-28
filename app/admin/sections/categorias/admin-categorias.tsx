"use client"

import { useMemo, useState } from "react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import { useCategorias } from "@/hooks/use-categorias"
import { useProductos } from "@/hooks/use-productos"

import { CategoriaForm } from "./categorias-form"
import { CategoriasTable } from "./categorias-table"
import { CategoriasToolbar } from "./categorias-toolbar"

export function AdminCategorias() {
  const {
    categorias,
    loading,
    deleteCategoria,
    reloadCategorias,
  } = useCategorias()

  const { productos } =
    useProductos()

  const [search, setSearch] =
    useState("")

  const [editando, setEditando] =
    useState<
      SupabaseCategoria | null | undefined
    >()

  const categoriasFiltradas =
    useMemo(
      () =>
        categorias.filter((c) =>
          c.nombre
            .toLowerCase()
            .includes(
              search.toLowerCase()
            )
        ),
      [categorias, search]
    )

  const categoryStats =
    useMemo(() => {
      const stats = new Map<
        number,
        {
          articulos: number
          stock: number
        }
      >()

      productos.forEach((producto) => {
        if (!producto.categoria_id) {
          return
        }

        const current =
          stats.get(
            producto.categoria_id
          ) || {
            articulos: 0,
            stock: 0,
          }

        const variantes =
          producto.producto_variantes || []

        const stock =
          variantes.length
            ? variantes.reduce(
                (total, variante) =>
                  total +
                  (variante.stock ?? 0),
                0
              )
            : producto.stock

        stats.set(
          producto.categoria_id,
          {
            articulos:
              current.articulos + 1,
            stock:
              current.stock + stock,
          }
        )
      })

      return stats
    }, [productos])

  const handleSaved =
    async () => {
      await reloadCategorias()

      setEditando(undefined)
    }

  if (editando !== undefined) {
    return (
      <CategoriaForm
        categoria={editando}
        onSaved={handleSaved}
        onCancel={() =>
          setEditando(
            undefined
          )
        }
      />
    )
  }

  return (
    <div className="p-8">
      <CategoriasToolbar
        search={search}
        onSearchChange={
          setSearch
        }
        onCreate={() =>
          setEditando(null)
        }
      />

      <CategoriasTable
        categorias={
          categoriasFiltradas
        }
        categoryStats={
          categoryStats
        }
        loading={loading}
        onEdit={setEditando}
        onDelete={async (
          id
        ) => {
          if (
            !confirm(
              "¿Eliminar esta categoría?"
            )
          ) {
            return
          }

          await deleteCategoria(
            id
          )
        }}
      />
    </div>
  )
}
