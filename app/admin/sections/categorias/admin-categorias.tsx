"use client"

import { useMemo, useState } from "react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import { useCategorias } from "@/hooks/use-categorias"

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