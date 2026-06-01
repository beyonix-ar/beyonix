"use client"

import {
  Plus,
  Search,
} from "lucide-react"

interface CategoriasToolbarProps {
  search: string

  onCreate: () => void

  onSearchChange: (
    value: string
  ) => void
}

export function CategoriasToolbar({
  search,
  onCreate,
  onSearchChange,
}: CategoriasToolbarProps) {
  return (
    <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
          Gestión
        </p>

        <h2 className="text-2xl font-bold text-white">
          Categorías
        </h2>
      </div>

      <div className="flex flex-1 gap-3 lg:max-w-xl">
        <div className="relative flex-1 lg:max-w-sm">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-white/25" />

          <input
            type="text"
            value={search}
            placeholder="Buscar categorías..."
            onChange={(e) =>
              onSearchChange(
                e.target.value
              )
            }
            className="h-11 w-full rounded-2xl border border-white/12 bg-black pl-11 pr-4 text-sm text-white outline-none transition-colors placeholder:text-white/30 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
          />
        </div>

        <button
          type="button"
          title="Nueva categoría"
          aria-label="Nueva categoría"
          onClick={onCreate}
          className="inline-flex h-12 min-w-160px items-center justify-center gap-2 rounded-2xl bg-white px-6 text-sm font-semibold text-black transition-all hover:bg-white/90 cursor-pointer"
        >
          <Plus className="size-4" />

          Nueva categoría
        </button>
      </div>
    </div>
  )
}
