import type {
  SupabaseProducto,
  SupabaseCategoria,
  SupabaseImagenProducto,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Formulario
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductoFormState {
  nombre: string
  slug: string
  descripcion: string
  video_url: string
  precio: string
  precio_anterior: string
  cuotas: "sin_cuotas" | "3" | "6"
  stock: string
  categoria_id: string
  destacado: boolean
  activo: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductosToolbarProps {
  search: string

  onSearchChange: (
    value: string
  ) => void

  onCreate: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductosTableProps {
  productos: SupabaseProducto[]

  loading: boolean

  onEdit: (
    producto: SupabaseProducto
  ) => void

  onDelete: (
    id: number
  ) => void

  onToggleActivo: (
    producto: SupabaseProducto
  ) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductosRowProps {
  producto: SupabaseProducto

  isLast?: boolean

  onEdit: (
    producto: SupabaseProducto
  ) => void

  onDelete: (
    id: number
  ) => void

  onToggleActivo: (
    producto: SupabaseProducto
  ) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Form
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductoFormProps {
  producto?: SupabaseProducto | null

  onSaved: () => void

  onCancel: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload imágenes
// ─────────────────────────────────────────────────────────────────────────────

export interface ImageUploaderProps {
  productoId: number
}

export interface DraftProductoVariante {
  tempId: string
  nombre: string
  color_hex: string
  stock: number | null
  imagenes: File[]
}

export interface DraftProductoEspecificacion {
  tempId: string
  icono: string
  texto: string
  orden: number
  activo: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────

export interface ToastState {
  msg: string
  type: "ok" | "err"
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard stats
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardStat {
  title: string
  value: string
  icon: React.ElementType
  change: string
  positive?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent order
// ─────────────────────────────────────────────────────────────────────────────

export interface RecentOrder {
  id: string
  cliente: string
  total: string
  estado: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Low stock
// ─────────────────────────────────────────────────────────────────────────────

export interface LowStockProduct {
  nombre: string
  stock: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-export útiles
// ─────────────────────────────────────────────────────────────────────────────

export type {
  SupabaseProducto,
  SupabaseCategoria,
  SupabaseImagenProducto,
}
