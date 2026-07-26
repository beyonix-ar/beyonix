alter table public.business_expenses
  add column if not exists category_detail text,
  add column if not exists recipient text;

comment on column public.business_expenses.category_detail is
  'Detalle opcional cuando la categoría del gasto es Otros.';

comment on column public.business_expenses.recipient is
  'Destinatario de un gasto categorizado como Donación/Regalo.';
