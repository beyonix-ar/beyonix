// ─────────────────────────────────────────────────────────────
// Categorías
// ─────────────────────────────────────────────────────────────

export interface SupabaseCategoria {
  id: number
  nombre: string
  slug: string
  descripcion?: string | null
  imagen?: string | null
  destacado?: boolean
  posicion_destacada?: 1 | 2 | 3 | null
  created_at: string
}

// ─────────────────────────────────────────────────────────────
// Imágenes producto
// ─────────────────────────────────────────────────────────────

export interface SupabaseImagenProducto {
  id: number
  producto_id: number
  url: string
  orden: number
  created_at: string
}

export interface SupabaseProductoVariante {
  id: number
  producto_id: number
  nombre: string
  color_hex: string
  stock: number | null
  imagenes: string[]
  activo: boolean
  orden: number
  created_at: string
}

export interface SupabaseProductoEspecificacion {
  id: number
  producto_id: number
  icono: string
  texto: string
  orden: number
  activo: boolean
  created_at: string
}

// ─────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────

export interface SupabaseProducto {
  id: number

  nombre: string
  slug: string
  descripcion: string | null

  precio: number
  precio_anterior: number | null
  descuento: number | null
  cuotas_sin_interes: boolean
  cuotas_maximas: 3 | 6 | null

  stock: number

  categoria_id: number | null

  destacado: boolean
  activo: boolean

  imagen_principal: string | null

  created_at: string

  categorias?: SupabaseCategoria | null

  imagenes_producto?: SupabaseImagenProducto[]
  producto_variantes?: SupabaseProductoVariante[]
  producto_especificaciones?: SupabaseProductoEspecificacion[]
}

// ─────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────

export interface SupabaseProfile {
  id: string
  email?: string | null
  username?: string | null
  nombre: string
  telefono?: string | null
  direccion?: string | null
  calle?: string | null
  numero?: string | null
  piso?: string | null
  departamento?: string | null
  localidad?: string | null
  codigo_postal?: string | null
  provincia?: string | null
  referencias?: string | null
  avatar_url?: string | null
  rol: "cliente" | "operador" | "admin" | "super_admin"
  client_risk_status?: "normal" | "tedioso" | "complicado"
  admin_note?: string | null
  blocked_at?: string | null
  blocked_reason?: string | null
  blocked_by?: string | null
  created_at: string
}

// Auditoria

export interface SupabaseAuditLog {
  id: number
  table_name: string
  action: "INSERT" | "UPDATE" | "DELETE"
  record_id: string | null
  actor_user_id: string | null
  actor_email: string | null
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  created_at: string
  undone_at: string | null
  undone_by: string | null
}

// ─────────────────────────────────────────────────────────────
// Pedidos
// ─────────────────────────────────────────────────────────────

export interface SupabasePedido {
  id: number
  usuario_id: string | null
  cliente_username?: string | null
  cliente_nombre?: string | null
  cliente_email?: string | null
  cliente_telefono?: string | null
  cliente_direccion?: string | null
  cp_destino?: string | null
  localidad?: string | null
  provincia?: string | null
  shipping_provider?: string | null
  shipping_type?: "sucursal" | "domicilio" | null
  shipping_cost_real?: number | null
  shipping_cost_charged?: number | null
  free_shipping_applied?: boolean
  estado: string
  total: number
  payment_id?: string | null
  payment_status?: string | null
  payment_method_id?: string | null
  payment_type_id?: string | null
  transfer_alias?: string | null
  transfer_discount_percent?: number | null
  transfer_discount_amount?: number | null
  payment_proof_url?: string | null
  payment_proof_file_name?: string | null
  payment_proof_uploaded_at?: string | null
  paid_at?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  envio_proveedor?: string | null
  andreani_estado?: string | null
  andreani_tracking?: string | null
  andreani_envio_id?: string | null
  andreani_etiqueta_url?: string | null
  andreani_costo?: number | null
  andreani_error?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
  invoice_cae?: string | null
  invoice_cae_due?: string | null
  invoice_status?: "processing" | "authorized" | "error" | null
  invoice_created_at?: string | null
  created_at: string
  orden_items?: SupabasePedidoItem[]
}

export interface SupabasePedidoItem {
  id: number
  orden_id: number
  producto_id: number
  variante_id?: number | null
  cantidad: number
  precio: number
  productos?: SupabaseProducto | null
  producto_variantes?: SupabaseProductoVariante | null
}

export interface SupabaseReview {
  id: number
  user_id: string
  order_id: number
  rating: number
  comment: string
  nickname: string
  city: string
  province: string
  approved: boolean
  created_at: string
}

// ─────────────────────────────────────────────────────────────
// Clientes
// ─────────────────────────────────────────────────────────────

export interface SupabaseCliente {
  id: string
  nombre: string
  apellido?: string | null
  username?: string | null
  email?: string | null
  telefono?: string | null
  direccion?: string | null
  codigo_postal?: string | null
  provincia?: string | null
  referencias?: string | null
  avatar_url?: string | null
  rol?: "cliente" | "operador" | "admin" | "super_admin"
  client_risk_status?: "normal" | "tedioso" | "complicado"
  admin_note?: string | null
  blocked_at?: string | null
  blocked_reason?: string | null
  blocked_by?: string | null
  created_at: string
  last_seen_at?: string | null
  is_active?: boolean
  current_cart?: Record<string, unknown> | unknown[] | null
  last_order?: SupabasePedido | null
  total_spent: number
  order_count: number
  status: "activo" | "inactivo" | "sin_compras"
}
