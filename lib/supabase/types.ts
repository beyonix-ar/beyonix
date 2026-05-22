// ─────────────────────────────────────────────────────────────────────────────
// Categorías
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseCategoria {
  id: number

  nombre: string

  slug: string

  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Imágenes producto
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseImagenProducto {
  id: number

  producto_id: number

  url: string

  orden: number

  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseProducto {
  id: number

  nombre: string

  slug: string

  descripcion: string | null

  precio: number

  precio_anterior: number | null

  descuento: number | null

  stock: number

  categoria_id: number | null

  destacado: boolean

  activo: boolean

  imagen_principal: string | null

  created_at: string

  // Relaciones
  categorias?: SupabaseCategoria | null

  imagenes_producto?: SupabaseImagenProducto[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseProfile {
  id: string

  nombre: string

  rol: "cliente" | "admin"

  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// ordenes
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabasePedido {
  id: number

  user_id: string | null

  estado: string

  total: number

  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Pedido items
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabasePedidoItem {
  id: number

  pedido_id: number

  producto_id: number

  cantidad: number

  precio_unitario: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Clientes
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseCliente {
  id: string

  nombre: string

  email: string

  telefono?: string | null

  created_at: string
}