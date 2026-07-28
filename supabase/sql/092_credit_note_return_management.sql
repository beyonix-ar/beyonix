-- Amplía las notas parciales existentes para representar la gestión comercial
-- asociada sin duplicar pedidos, reclamos ni movimientos de saldo.
alter table public.order_credit_notes
  add column if not exists operation_type text not null default 'devolucion_parcial',
  add column if not exists reason_code text not null default 'otro',
  add column if not exists reason_detail text,
  add column if not exists resolution_type text not null default 'saldo_favor',
  add column if not exists management_status text not null default 'nota_credito_pendiente',
  add column if not exists reception_status text not null default 'pendiente_despacho',
  add column if not exists reception_exception boolean not null default false,
  add column if not exists reception_date date,
  add column if not exists reception_notes text,
  add column if not exists physical_condition text,
  add column if not exists accessories_complete boolean,
  add column if not exists original_packaging text,
  add column if not exists original_shipping_paid numeric(12, 2) not null default 0,
  add column if not exists original_shipping_discounted numeric(12, 2) not null default 0,
  add column if not exists original_shipping_refunded numeric(12, 2) not null default 0,
  add column if not exists return_shipping_party text not null default 'cliente',
  add column if not exists return_shipping_provider text,
  add column if not exists return_shipping_tracking text,
  add column if not exists return_shipping_cost numeric(12, 2) not null default 0,
  add column if not exists return_shipping_dispatched_at date,
  add column if not exists return_shipping_received_at date,
  add column if not exists new_shipping_party text not null default 'no_corresponde',
  add column if not exists new_shipping_cost numeric(12, 2) not null default 0,
  add column if not exists other_adjustment_amount numeric(12, 2) not null default 0,
  add column if not exists stock_destination text not null default 'pendiente_revision',
  add column if not exists stock_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists stock_reviewed_at timestamptz,
  add column if not exists settlement_status text not null default 'pendiente',
  add column if not exists settlement_reference text,
  add column if not exists settlement_date date;

alter table public.order_credit_notes
  drop constraint if exists order_credit_notes_operation_type_check,
  add constraint order_credit_notes_operation_type_check check (
    operation_type in (
      'devolucion_parcial',
      'devolucion_total',
      'cambio_producto',
      'cancelacion_antes_despacho',
      'reembolso_excepcional',
      'ajuste_manual'
    )
  ),
  drop constraint if exists order_credit_notes_reason_code_check,
  add constraint order_credit_notes_reason_code_check check (
    reason_code in (
      'arrepentimiento',
      'producto_defectuoso',
      'producto_incorrecto',
      'producto_faltante',
      'producto_danado_envio',
      'garantia_aprobada',
      'cancelacion_antes_despacho',
      'error_administrativo',
      'otro'
    )
  ),
  drop constraint if exists order_credit_notes_resolution_type_check,
  add constraint order_credit_notes_resolution_type_check check (
    resolution_type in (
      'saldo_favor',
      'medio_pago',
      'transferencia',
      'cambio_producto',
      'reposicion_sin_costo',
      'ajuste_administrativo'
    )
  ),
  drop constraint if exists order_credit_notes_management_status_check,
  add constraint order_credit_notes_management_status_check check (
    management_status in (
      'borrador',
      'esperando_devolucion',
      'producto_transito',
      'pendiente_revision',
      'aprobada',
      'nota_credito_pendiente',
      'nota_credito_emitida',
      'acreditacion_pendiente',
      'reembolso_pendiente',
      'cambio_pendiente',
      'finalizada',
      'rechazada',
      'cancelada'
    )
  ),
  drop constraint if exists order_credit_notes_reception_status_check,
  add constraint order_credit_notes_reception_status_check check (
    reception_status in (
      'no_requiere',
      'pendiente_despacho',
      'en_transito',
      'recibido_revision',
      'producto_aprobado',
      'producto_rechazado',
      'aprobado_parcial'
    )
  ),
  drop constraint if exists order_credit_notes_return_shipping_party_check,
  add constraint order_credit_notes_return_shipping_party_check check (
    return_shipping_party in ('cliente', 'beyonix', 'no_corresponde')
  ),
  drop constraint if exists order_credit_notes_new_shipping_party_check,
  add constraint order_credit_notes_new_shipping_party_check check (
    new_shipping_party in ('cliente', 'beyonix', 'no_corresponde')
  ),
  drop constraint if exists order_credit_notes_stock_destination_check,
  add constraint order_credit_notes_stock_destination_check check (
    stock_destination in (
      'stock_vendible',
      'stock_observaciones',
      'fallado',
      'garantia_proveedor',
      'no_reingresar',
      'pendiente_revision'
    )
  ),
  drop constraint if exists order_credit_notes_settlement_status_check,
  add constraint order_credit_notes_settlement_status_check check (
    settlement_status in ('pendiente', 'procesando', 'completado', 'rechazado')
  ),
  drop constraint if exists order_credit_notes_shipping_amounts_check,
  add constraint order_credit_notes_shipping_amounts_check check (
    original_shipping_paid >= 0
    and original_shipping_discounted >= 0
    and original_shipping_refunded >= 0
    and original_shipping_refunded <= original_shipping_paid
    and return_shipping_cost >= 0
    and new_shipping_cost >= 0
    and other_adjustment_amount >= 0
  );

alter table public.order_credit_note_items
  add column if not exists return_status text not null default 'pendiente_devolucion',
  add column if not exists received_quantity integer not null default 0,
  add column if not exists approved_quantity integer not null default 0,
  add column if not exists rejected_quantity integer not null default 0,
  add column if not exists stock_processed_at timestamptz;

alter table public.order_credit_note_items
  drop constraint if exists order_credit_note_items_return_status_check,
  add constraint order_credit_note_items_return_status_check check (
    return_status in (
      'pendiente_devolucion',
      'recibido',
      'recibido_correctamente',
      'recibido_observaciones',
      'rechazado',
      'resuelto'
    )
  ),
  drop constraint if exists order_credit_note_items_reception_quantities_check,
  add constraint order_credit_note_items_reception_quantities_check check (
    received_quantity >= 0
    and approved_quantity >= 0
    and rejected_quantity >= 0
    and received_quantity <= quantity
    and approved_quantity + rejected_quantity <= received_quantity
  );

create index if not exists order_credit_notes_management_status_idx
  on public.order_credit_notes(order_id, management_status, created_at desc);

-- Conserva como cerradas las resoluciones históricas que ya habían sido
-- aplicadas antes de incorporar el estado detallado.
update public.order_credit_notes note
set settlement_status = 'completado',
    management_status = 'finalizada',
    settlement_date = coalesce(note.authorized_at::date, note.created_at::date)
where note.status = 'authorized'
  and (
    note.destination = 'customer_balance'
    or exists (
      select 1
      from public.ordenes orders
      where orders.id = note.order_id
        and orders.financial_status = 'refunded'
    )
  );

comment on column public.order_credit_notes.original_shipping_refunded is
  'Importe efectivamente pagado por el cliente que integra la nota. Nunca incluye envío bonificado.';

comment on column public.order_credit_notes.settlement_status is
  'Estado de la aplicación comercial posterior al CAE; permite reintentar sin volver a emitir.';
