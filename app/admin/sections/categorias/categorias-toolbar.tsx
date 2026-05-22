"use client"

import { Search, Plus } from "lucide-react"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface CategoriasToolbarProps {
  search: string

  onSearchChange: (
    value: string
  ) => void

  onCreate: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function CategoriasToolbar({
  search,
  onSearchChange,
  onCreate,
}: CategoriasToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-4 mb-8">
      {/* Search */}
      <div className="relative flex-1 max-w-420px">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-white/25 pointer-events-none" />

        <input
          id="search-categorias-input"
          type="text"
          title="Buscar categorías"
          placeholder="Buscar categorías..."
          value={search}
          onChange={(e) =>
            onSearchChange(
              e.target.value
            )
          }
          className="w-full h-12 bg-[#0A0A0A] border border-white/8 rounded-2xl pl-11 pr-4 text-sm text-white placeholder:text-white/25 outline-none focus:border-[#1E4D7B] transition-colors"
        />
      </div>

      {/* Nuevo */}
      <button
        type="button"
        title="Nueva categoría"
        onClick={onCreate}
        className="h-12 px-5 rounded-2xl bg-white text-black text-sm font-semibold hover:bg-white/90 transition-colors inline-flex items-center gap-2 shrink-0 cursor-pointer"
      >
        <Plus className="size-4" />
        Nueva categoría
      </button>
    </div>
  )
}