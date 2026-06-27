alter table public.order_claims
  drop constraint if exists order_claims_status_check,
  add constraint order_claims_status_check check (
    status in (
      'recibido',
      'en_revision',
      'falta_informacion',
      'aprobado',
      'reintegro_pendiente',
      'rechazado',
      'cerrado'
    )
  );

alter table public.order_claims
  add column if not exists refund_account_holder text,
  add column if not exists refund_account_identifier text,
  add column if not exists refund_bank text,
  add column if not exists refund_amount_confirmed text,
  add column if not exists refund_details_submitted_at timestamptz,
  add column if not exists refund_completed_at timestamptz,
  add column if not exists refund_completed_by uuid references auth.users(id) on delete set null;

alter table public.order_claim_files
  drop constraint if exists order_claim_files_file_role_check,
  add constraint order_claim_files_file_role_check check (
    file_role in (
      'embalaje_exterior',
      'producto_completo',
      'danio',
      'funcionamiento_foto',
      'video',
      'evidencia_adicional',
      'comprobante_devolucion'
    )
  );

drop index if exists order_claims_one_active_per_order_idx;
create unique index if not exists order_claims_one_active_per_order_idx
  on public.order_claims (order_id)
  where status in (
    'recibido',
    'en_revision',
    'falta_informacion',
    'aprobado',
    'reintegro_pendiente'
  );

create or replace function public.clear_resolved_order_claim_attention()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('aprobado', 'cerrado', 'rechazado') then
    new.admin_needs_action := false;
  end if;
  return new;
end;
$$;
