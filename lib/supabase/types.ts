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

export type OrderFinancialStatus =
  | "pending_payment"
  | "payment_submitted"
  | "payment_confirmed"
  | "cancellation_requested"
  | "refund_pending"
  | "refunded"
  | "cancelled"

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
  financial_status?: OrderFinancialStatus | null
  payment_confirmed_by?: string | null
  payment_confirmed_at?: string | null
  payment_confirmed_amount?: number | null
  payment_confirmation_observation?: string | null
  cancellation_requested_by?: string | null
  cancellation_requested_at?: string | null
  refund_pending_at?: string | null
  refund_proof_url?: string | null
  refund_proof_file_name?: string | null
  refund_proof_mime_type?: string | null
  refund_proof_file_size?: number | null
  refund_amount?: number | null
  refund_method?: string | null
  refund_observation?: string | null
  refund_internal_note?: string | null
  refund_uploaded_by?: string | null
  refund_uploaded_at?: string | null
  refunded_at?: string | null
  refunded_by?: string | null
  credit_note_required?: boolean | null
  credit_note_issued?: boolean | null
  credit_note_number?: string | null
  credit_note_issued_at?: string | null
  credit_note_status?: "pending" | "processing" | "authorized" | "error" | null
  credit_note_point?: number | null
  credit_note_cae?: string | null
  credit_note_cae_due?: string | null
  credit_note_created_at?: string | null
  credit_note_amount?: number | null
  credit_note_error?: string | null
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
  order_change_used?: boolean | null
  order_change_status?: "change_requested" | "change_approved" | "extra_payment_pending" | "rejected" | null
  order_change_extra_amount?: number | null
  invoice_number?: number | null
  invoice_point?: number | null
  invoice_cae?: string | null
  invoice_cae_due?: string | null
  invoice_status?: "pending" | "processing" | "authorized" | "error" | null
  invoice_error?: string | null
  invoice_created_at?: string | null
  return_status?:
    | "solicitada"
    | "en_revision"
    | "aprobada"
    | "rechazada"
    | "resuelta"
    | null
  return_reason?: string | null
  return_requested_at?: string | null
  return_resolved_at?: string | null
  return_admin_note?: string | null
  delivered_at?: string | null
  cancelled_at?: string | null
  created_at: string
  orden_items?: SupabasePedidoItem[]
  order_claims?: SupabaseOrderClaim[]
  order_refund_proofs?: SupabaseOrderRefundProof[]
  order_audit_events?: SupabaseOrderAuditEvent[]
}

export interface SupabaseOrderRefundProof {
  id: number
  order_id: number
  uploaded_by?: string | null
  file_name: string
  file_path: string
  mime_type: string
  file_size: number
  amount: number
  method?: string | null
  observation?: string | null
  signedUrl?: string | null
  created_at: string
}

export interface SupabaseOrderAuditEvent {
  id: number
  order_id: number
  actor_type: "customer" | "admin" | "system"
  actor_id?: string | null
  action: string
  previous_status?: string | null
  new_status?: string | null
  metadata?: Record<string, unknown> | null
  created_at: string
}

export interface SupabaseCustomerNotification {
  id: string
  user_id: string
  type: string
  title: string
  body: string
  action_url: string | null
  order_id: number | null
  is_read: boolean
  created_at: string
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

export type OrderClaimType = "transporte_48hs" | "garantia_beyonix"
export type OrderClaimStatus =
  | "recibido"
  | "en_revision"
  | "falta_informacion"
  | "aprobado"
  | "reintegro_pendiente"
  | "cambio_pendiente"
  | "cupon_pendiente"
  | "reemplazo_enviado"
  | "rechazado"
  | "cerrado"
export type OrderClaimResolution =
  | "cambio_producto"
  | "reintegro_total"
  | "reintegro_parcial"
  | "cupon_descuento"
  | "rechazado"
  | "otro"

export interface SupabaseOrderClaimFile {
  id: number
  claim_id: number
  uploaded_by?: string | null
  file_role: string
  file_name: string
  file_path: string
  mime_type: string
  file_size: number
  signedUrl?: string | null
  created_at: string
}

export interface SupabaseOrderClaimMessage {
  id: number
  claim_id: number
  author_user_id?: string | null
  author_role: "cliente" | "operador" | "admin" | "super_admin"
  message: string
  created_at: string
}

export interface SupabaseOrderClaim {
  id: number
  order_id: number
  user_id: string
  claim_type: OrderClaimType
  status: OrderClaimStatus
  failure_type?: string | null
  description: string
  started_at?: string | null
  admin_response?: string | null
  rejection_reason?: string | null
  resolution?: OrderClaimResolution | null
  offered_resolutions?: OrderClaimResolution[]
  customer_selected_resolution?: OrderClaimResolution | null
  refund_account_holder?: string | null
  refund_account_identifier?: string | null
  refund_bank?: string | null
  refund_amount_confirmed?: string | null
  refund_details_submitted_at?: string | null
  refund_completed_at?: string | null
  refund_completed_by?: string | null
  replacement_original_product?: string | null
  replacement_original_order_item_id?: number | null
  replacement_original_variant?: string | null
  replacement_original_price?: number | null
  replacement_requested_product_id?: number | null
  replacement_requested_product?: string | null
  replacement_requested_variant_id?: number | null
  replacement_requested_variant?: string | null
  replacement_requested_quantity?: number | null
  replacement_requested_stock?: number | null
  replacement_requested_price?: number | null
  replacement_price_difference?: number | null
  replacement_change_reason?: string | null
  replacement_customer_selected_at?: string | null
  replacement_product?: string | null
  replacement_extra_cost?: number | null
  replacement_payment_link?: string | null
  replacement_shipping_company?: string | null
  replacement_tracking?: string | null
  replacement_sent_at?: string | null
  coupon_code?: string | null
  coupon_created_at?: string | null
  closed_at?: string | null
  created_at: string
  updated_at: string
  first_reviewed_at?: string | null
  first_reviewed_by?: string | null
  last_customer_message_at?: string | null
  last_admin_response_at?: string | null
  admin_needs_action?: boolean
  order_claim_files?: SupabaseOrderClaimFile[]
  order_claim_messages?: SupabaseOrderClaimMessage[]
}

export interface SupabaseReview {
  id: number
  user_id: string
  order_id: number
  product_id?: number | null
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
