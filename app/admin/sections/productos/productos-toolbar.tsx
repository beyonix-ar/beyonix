"use client"

import { Plus, Search } from "lucide-react"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ProductosToolbarProps {
  search: string
  onSearchChange: (value: string) => void
  onCreate: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function ProductosToolbar({
  search,
  onSearchChange,
  onCreate,
}: ProductosToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-4 mb-6">
      {/* Left */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
          Gestión
        </p>

        <h2 className="text-2xl font-bold text-white">
          Productos
        </h2>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-md relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-white/25" />

        <input
          type="text"
          value={search}
          placeholder="Buscar producto..."
          onChange={(e) =>
            onSearchChange(e.target.value)
          }
          className="w-full h-11 rounded-2xl border border-white/8 bg-[#0A0A0A] pl-11 pr-4 text-sm text-white placeholder:text-white/25 outline-none focus:border-[#1E4D7B] transition-colors"
        />
      </div>

      {/* Button */}
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-2 h-11 px-5 rounded-2xl bg-white text-black text-sm font-semibold hover:bg-white/90 transition-all cursor-pointer"
      >
        <Plus className="size-4" />

        Nuevo producto
      </button>
    </div>
  )
}