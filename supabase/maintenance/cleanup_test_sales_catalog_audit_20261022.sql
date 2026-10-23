-- Auditoría del snapshot previo: estas 32 filas de auditoría de stock
-- comparten transacción con auditorías de los pedidos 9, 10 y 11,
-- la devolución o el reemplazo de esas ventas. Conserva toda otra auditoría.
begin;
create temp table _target_audit_ids(id bigint primary key) on commit drop;
insert into _target_audit_ids(id) values
  (1236),(1237),(1077),(1078),(1081),(1082),(1084),(1085),
  (1239),(1240),(1242),(1243),(1245),(1244),(1096),(1097),
  (1098),(1099),(1102),(1103),(1104),(1105),(1107),(1108),
  (1109),(1110),(1366),(1367),(1375),(1376),(1378),(1379);
do $$ begin
  if (select count(*) from public.audit_logs where id in (select id from _target_audit_ids)) <> 32
    or exists (
      select 1 from public.audit_logs a join _target_audit_ids t using (id)
      where a.table_name not in ('productos','producto_variantes')
        or (a.before_data - 'stock' - 'stock_adjustment_delta' - 'stock_adjustment_reason')
          is distinct from (a.after_data - 'stock' - 'stock_adjustment_delta' - 'stock_adjustment_reason')
    ) then raise exception 'Las trazas de stock auditadas cambiaron'; end if;
end $$;
delete from public.audit_logs where id in (select id from _target_audit_ids);
select count(*) as removed_catalog_stock_audits from _target_audit_ids;
commit;
