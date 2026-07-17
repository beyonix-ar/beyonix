"use client"

import { useEffect, useMemo, useState } from "react"

import { useCategorias } from "@/hooks/use-categorias"
import { useProductos } from "@/hooks/use-productos"
import { updateCategoria } from "@/lib/supabase/queries/categorias"
import type { SupabaseCategoria } from "@/lib/supabase/types"

import { CategoriaForm } from "./categorias-form"
import { CategoriasTable } from "./categorias-table"

type FeaturedPosition = 1 | 2 | 3

const featuredPositions: FeaturedPosition[] = [1, 2, 3]

interface AdminCategoriasProps {
  createSignal: number
  search: string
}

export function AdminCategorias({ createSignal, search }: AdminCategoriasProps) {
  const { categorias, loading, deleteCategoria, reloadCategorias } =
    useCategorias()
  const { productos } = useProductos()

  const [editando, setEditando] = useState<
    SupabaseCategoria | null | undefined
  >()
  const [normalizingPositions, setNormalizingPositions] = useState(false)

  useEffect(() => {
    if (createSignal > 0) {
      setEditando(null)
    }
  }, [createSignal])

  useEffect(() => {
    if (!categorias.length || normalizingPositions) {
      return
    }

    const usedPositions = new Set<FeaturedPosition>()
    const updates = categorias
      .filter(
        (categoria) =>
          categoria.destacado &&
          categoria.posicion_destacada
      )
      .sort(
        (a, b) =>
          (a.posicion_destacada ?? 99) -
            (b.posicion_destacada ?? 99) ||
          a.nombre.localeCompare(b.nombre)
      )
      .flatMap((categoria) => {
        const position = categoria.posicion_destacada

        if (!position || !usedPositions.has(position)) {
          if (position) {
            usedPositions.add(position)
          }

          return []
        }

        const replacement =
          featuredPositions.find(
            (nextPosition) => !usedPositions.has(nextPosition)
          ) ?? null

        if (replacement) {
          usedPositions.add(replacement)
        }

        return [
          updateCategoria(categoria.id, {
            posicion_destacada: replacement,
          }),
        ]
      })

    if (!updates.length) {
      return
    }

    setNormalizingPositions(true)

    Promise.all(updates)
      .then(() => reloadCategorias())
      .catch((error) => {
        console.error("Error normalizando posiciones destacadas:", error)
      })
      .finally(() => {
        setNormalizingPositions(false)
      })
  }, [categorias, normalizingPositions, reloadCategorias])

  const categoriasFiltradas = useMemo(
    () =>
      categorias.filter((categoria) =>
        categoria.nombre.toLowerCase().includes(search.toLowerCase())
      ),
    [categorias, search]
  )

  const categoryStats = useMemo(() => {
    const stats = new Map<
      number,
      {
        articulos: number
        stock: number
      }
    >()

    productos.forEach((producto) => {
      if (!producto.categoria_id) return

      const current = stats.get(producto.categoria_id) || {
        articulos: 0,
        stock: 0,
      }

      const variantes = producto.producto_variantes || []
      const stock = variantes.length
        ? variantes.reduce(
            (total, variante) => total + (variante.stock ?? 0),
            0
          )
        : producto.stock

      stats.set(producto.categoria_id, {
        articulos: current.articulos + 1,
        stock: current.stock + stock,
      })
    })

    return stats
  }, [productos])

  const getReplacementFeaturedPosition = (
    target: SupabaseCategoria,
    occupyingCategory: SupabaseCategoria,
    nextPosition: FeaturedPosition
  ) => {
    const previousPosition =
      categorias.find((categoria) => categoria.id === target.id)
        ?.posicion_destacada ?? null

    const previousPositionIsFree =
      previousPosition &&
      previousPosition !== nextPosition &&
      !categorias.some(
        (categoria) =>
          categoria.id !== target.id &&
          categoria.id !== occupyingCategory.id &&
          categoria.destacado &&
          categoria.posicion_destacada === previousPosition
      )

    if (previousPositionIsFree) {
      return previousPosition
    }

    return (
      featuredPositions.find(
        (position) =>
          position !== nextPosition &&
          !categorias.some(
            (categoria) =>
              categoria.id !== target.id &&
              categoria.id !== occupyingCategory.id &&
              categoria.destacado &&
              categoria.posicion_destacada === position
          )
      ) ?? null
    )
  }

  const resolveFeaturedPositionConflict = async (
    target: SupabaseCategoria,
    nextPosition: FeaturedPosition
  ) => {
    const occupyingCategory = categorias.find(
      (categoria) =>
        categoria.id !== target.id &&
        categoria.destacado &&
        categoria.posicion_destacada === nextPosition
    )

    if (!occupyingCategory) {
      return
    }

    await updateCategoria(occupyingCategory.id, {
      posicion_destacada: getReplacementFeaturedPosition(
        target,
        occupyingCategory,
        nextPosition
      ),
    })
  }

  const handleSaved = async (savedCategory?: SupabaseCategoria) => {
    if (savedCategory?.destacado && savedCategory.posicion_destacada) {
      await resolveFeaturedPositionConflict(
        savedCategory,
        savedCategory.posicion_destacada
      )
    }

    await reloadCategorias()
    setEditando(undefined)
  }

  const handleToggleDestacado = async (categoria: SupabaseCategoria) => {
    await updateCategoria(categoria.id, {
      destacado: !categoria.destacado,
      posicion_destacada: categoria.destacado
        ? null
        : categoria.posicion_destacada ?? null,
    })

    await reloadCategorias()
  }

  const handlePositionChange = async (
    categoria: SupabaseCategoria,
    position: FeaturedPosition | null
  ) => {
    if (position) {
      await resolveFeaturedPositionConflict(categoria, position)
    }

    await updateCategoria(categoria.id, {
      destacado: position ? true : categoria.destacado,
      posicion_destacada: position,
    })

    await reloadCategorias()
  }

  if (editando !== undefined) {
    return (
      <CategoriaForm
        categoria={editando}
        onSaved={handleSaved}
        onCancel={() => setEditando(undefined)}
      />
    )
  }

  return (
    <div className="space-y-6">
      <CategoriasTable
        categorias={categoriasFiltradas}
        categoryStats={categoryStats}
        loading={loading}
        onEdit={setEditando}
        onToggleDestacado={handleToggleDestacado}
        onPositionChange={handlePositionChange}
        onDelete={async (id) => {
          if (!confirm("¿Eliminar esta categoría?")) return

          await deleteCategoria(id)
        }}
      />
    </div>
  )
}
