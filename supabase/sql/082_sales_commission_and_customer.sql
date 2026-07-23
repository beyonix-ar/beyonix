alter table public.external_sales
  add column if not exists fee_type text not null default 'amount'
    check (fee_type in ('amount', 'percent')),
  add column if not exists fee_value numeric(12, 2) not null default 0
    check (fee_value >= 0),
  add column if not exists customer_name text;

alter table public.mercadolibre_sales
  add column if not exists fee_type text not null default 'amount'
    check (fee_type in ('amount', 'percent')),
  add column if not exists fee_value numeric(12, 2) not null default 0
    check (fee_value >= 0),
  add column if not exists customer_name text;

update public.external_sales
set fee_value = coalesce(fee_amount, 0)
where fee_type = 'amount'
  and fee_value = 0
  and coalesce(fee_amount, 0) > 0;

update public.mercadolibre_sales
set fee_value = coalesce(fee_amount, 0)
where fee_type = 'amount'
  and fee_value = 0
  and coalesce(fee_amount, 0) > 0;
