do $$
begin
  alter publication supabase_realtime add table public.customer_credit_topups;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.customer_credit_movements;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
