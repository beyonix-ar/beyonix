"use client"

interface CategoryToolbarProps {
  search: string
  onSearchChange: (value: string) => void
}

export function CategoryToolbar({
  search,
  onSearchChange,
}: CategoryToolbarProps) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <input
        type="text"
        placeholder="Buscá el producto hecho para vos..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="w-full sm:max-w-md rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 outline-none transition-all focus:border-beyonix-blue focus:bg-white/10"
      />
    </div>
  )
}
