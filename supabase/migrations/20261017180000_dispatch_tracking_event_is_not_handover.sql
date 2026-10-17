-- La primera consulta de tracking puede registrar un evento antes de que el
-- operador controle el Bulto. Sólo un estado efectivo de transporte lo bloquea.
do $migration$
declare
  v_definition text;
  v_old text := 'if o.andreani_tracking_event_at is not null or nullif(btrim(o.tracking_number),'''') is not null';
  v_new text := 'if nullif(btrim(o.tracking_number),'''') is not null';
begin
  select pg_get_functiondef('public.dispatch_order_block_reasons(bigint)'::regprocedure)
    into v_definition;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'No se encontró la condición de tracking esperada';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$migration$;

select public.sync_dispatch_blocks(id) from public.ordenes;
