begin;
set local statement_timeout = '20s';
set local lock_timeout = '2s';
select set_config('request.jwt.claim.role','service_role',true);
create temp table audit67_results (scenario text, result jsonb) on commit drop;
do $audit$
declare
 actor uuid; prod bigint := 2000000067; variant bigint := 2000000067; ord bigint := 2000000067; item bigint := 2000000067;
 claim bigint := 2000000067; ml uuid := gen_random_uuid(); sale uuid := gen_random_uuid(); tag text := 'audit67-' || gen_random_uuid();
 row_item public.orden_items; review public.inventory_return_movements; replacement public.order_replacements; reversal public.external_sales;
 initial_stock integer; approved timestamptz; caught text; result jsonb; purchase_id uuid;
begin
 select id into strict actor from profiles where rol='super_admin' limit 1;
insert into productos(id,nombre,slug,precio,activo,categoria_id,descripcion,peso_empaquetado_kg,alto_paquete_cm,ancho_paquete_cm,largo_paquete_cm) overriding system value values(prod,'Validación aislada Ñandú',tag,1000,true,(select id from categorias limit 1),'Descripción de validación',1,10,10,10);
 insert into producto_especificaciones(producto_id,icono,texto,activo) values(prod,'Package','Especificación de validación',true);
insert into producto_variantes(id,producto_id,nombre,color_hex,sku,activo,imagenes) overriding system value values(variant,prod,'Azul auditoría','#123456',tag,true,'["https://example.invalid/audit.png"]');
 perform adjust_variant_stock_idempotent(variant,20,'Validación temporal con rollback',actor,tag||'-seed');
 assert (select stock from producto_variantes where id=variant)=20, 'seed stock';
 insert into ordenes(id,total,estado,payment_status,financial_status,admin_visible_at) overriding system value values(ord,5000,'entregado','approved','payment_confirmed',now());
 insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) overriding system value values(item,ord,prod,variant,5,1000);
 insert into order_claims(id,order_id,user_id,claim_type,description,failure_type,status,affected_items) values(claim,ord,actor,'garantia_beyonix','Validación temporal rollback','danado','aprobado',jsonb_build_array(jsonb_build_object('order_item_id',item,'quantity',3)));
 initial_stock := (select stock from producto_variantes where id=variant);
 begin
   perform create_order_replacement(ord,item,variant,1,'otra_variante',actor,tag||'-no-receipt');
   raise exception 'TEST_EXPECTED_REJECTION';
 exception when others then assert sqlerrm like '%REPLACEMENT_REQUIRES_RECEIVED_ITEM%', sqlerrm; end;
 row_item := process_claim_return_inventory(claim,ord,item,2,0,'Recepción parcial 2 de 3',actor,tag||'-receive2');
 assert row_item.return_restocked_quantity=2, 'first receipt';
 assert (select stock from producto_variantes where id=variant)=initial_stock+2, 'first receipt stock';
 perform process_claim_return_inventory(claim,ord,item,2,0,'Recepción parcial 2 de 3',actor,tag||'-receive2');
 assert (select stock from producto_variantes where id=variant)=initial_stock+2, 'receipt retry stock';
 row_item := process_claim_return_inventory(claim,ord,item,1,0,'Recepción final 1 de 3',actor,tag||'-receive1');
 assert row_item.return_restocked_quantity=3, 'final receipt';
 assert (select stock from producto_variantes where id=variant)=initial_stock+3, 'final receipt stock';
 begin
   perform process_claim_return_inventory(claim,ord,item,1,0,'No debe exceder reclamo',actor,tag||'-exceed');
   raise exception 'TEST_EXPECTED_REJECTION';
 exception when others then assert sqlerrm ~ 'RETURN_EXCEEDS_REMAINING|CLAIM_INVALID_ITEMS', sqlerrm; end;
 insert into audit67_results values('partial_returns',jsonb_build_object('sold',5,'claimed',3,'firstReceived',2,'firstRemaining',1,'finalReceived',3,'finalRemaining',0,'retryNoDuplicate',true,'overClaimBlocked',true));
 initial_stock := (select stock from producto_variantes where id=variant);
 replacement := create_order_replacement(ord,item,variant,1,'otra_variante',actor,tag||'-replacement');
 perform create_order_replacement(ord,item,variant,1,'otra_variante',actor,tag||'-replacement');
 assert (select stock from producto_variantes where id=variant)=initial_stock-1, 'replacement stock once';
 assert (select count(*) from order_replacements where original_order_id=ord)=1, 'replacement once';
 assert exists(select from audit_logs where table_name='order_replacements' and record_id=replacement.id::text and actor_user_id=actor), 'central audit';
 assert exists(select from order_audit_events where order_id=ord and action='order_replacement_created'), 'timeline';
 perform adjust_variant_stock_idempotent(variant,0,'Validación sin stock',actor,tag||'-zero');
 begin
   perform create_order_replacement(ord,item,variant,1,'otra_variante',actor,tag||'-no-stock');
   raise exception 'TEST_EXPECTED_REJECTION';
 exception when others then assert sqlerrm like '%STOCK_INSUFICIENTE%', sqlerrm; end;
 perform adjust_variant_stock_idempotent(variant,20,'Reposición temporal para validación',actor,tag||'-restore');
 insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) overriding system value values(item+1,ord,prod,variant,1,1000);
 perform create_order_replacement(ord,item+1,variant,1,'garantia',actor,tag||'-warranty');
 insert into audit67_results values('replacements',jsonb_build_object('stockOnce',true,'retryNoDuplicate',true,'centralAudit',true,'timeline',true,'requiresReception',true,'warrantyException',true,'insufficientStockBlocked',true));
 insert into mercadolibre_sales(id,product_id,product_name,sku,quantity,source_key,raw_data) values(ml,prod,'Validación ML',tag,3,tag,jsonb_build_object('parsed',jsonb_build_object('status','Devolución'),'beyonix_cost_mapping',jsonb_build_object('variant_id',variant)));
 initial_stock := (select stock from producto_variantes where id=variant);
 review := review_mercadolibre_return(ml,3,1,1,1,10,'Caja dañada','Roto','Primera revisión',now(),actor,null,null);
 approved := review.approved_at;
 assert review.sellable_quantity=1 and review.discounted_quantity=1 and review.non_sellable_quantity=1, 'ML classification';
 assert (select stock from producto_variantes where id=variant)=initial_stock+1, 'ML normal stock';
 begin
   perform review_mercadolibre_return(ml,3,2,0,1,null,null,'Roto',null,now(),actor,approved,null);
   raise exception 'TEST_EXPECTED_REJECTION';
 exception when others then assert sqlerrm like '%ML_RETURN_CORRECTION_REASON_REQUIRED%', sqlerrm; end;
 review := review_mercadolibre_return(ml,3,2,0,1,null,null,'Roto',null,now(),actor,approved,'Corrección verificada');
 assert (select stock from producto_variantes where id=variant)=initial_stock+2, 'ML correction stock';
 begin
   perform review_mercadolibre_return(ml,3,3,0,0,null,null,null,null,now(),actor,approved-interval '1 second','Versión desactualizada');
   raise exception 'TEST_EXPECTED_REJECTION';
 exception when others then assert sqlerrm like '%ML_RETURN_CONFLICT%', sqlerrm; end;
 assert (select sellable_quantity from inventory_return_movements where mercadolibre_sale_id=ml)=2, 'ML conflict preserved';
 insert into audit67_results values('ML',jsonb_build_object('firstNull',true,'classification',true,'derivedStock',true,'correctionReasonRequired',true,'currentVersionAccepted',true,'staleVersionBlocked',true));
 initial_stock := (select stock from producto_variantes where id=variant);
 insert into external_sales(id,product_id,variant_id,product_name,sku,quantity,unit_price,gross_amount,net_amount) values(sale,prod,variant,'Validación externa',tag,2,1000,2000,2000);
 assert (select stock from producto_variantes where id=variant)=initial_stock-2, 'external sold stock';
 reversal := reverse_external_sale(sale,'Validación reversión aislada',actor,tag||'-reverse');
 perform reverse_external_sale(sale,'Validación reversión aislada',actor,tag||'-reverse');
 assert (select stock from producto_variantes where id=variant)=initial_stock, 'external restored once';
 assert reversal.reversal_amount=2000 and reversal.reversed_by=actor and reversal.reversed_at is not null and reversal.status='reversed', 'external evidence';
 assert exists(select from audit_logs where table_name='external_sales' and record_id=sale::text and after_data->>'status'='reversed'), 'reversal audit';
 insert into audit67_results values('external_reversal',jsonb_build_object('restored',2,'retryNoDuplicate',true,'amount',2000,'actorDateReason',true,'audit',true));
 initial_stock := (select stock from producto_variantes where id=variant);
 select (save_product_purchase_atomic(jsonb_build_object('product_id',prod,'variant_id',variant,'quantity',6,'received_quantity',6,'reception_status','recibida','purchase_date',current_date-1,'unit_cost',1000),actor)).id into purchase_id;
 result := admin_force_delete_impact('purchase',purchase_id::text);
 assert (result->>'receivedQuantity')::integer=6, 'purchase received';
 assert (result->>'projectedStock')::integer=(result->>'currentStock')::integer-6, 'purchase projected stock';
 assert (result->>'affectedSales')::integer>0, 'purchase subsequent sales';
 assert result->>'confirmation'='ELIMINAR COMPRA '||purchase_id::text, 'purchase typed confirmation';
 result := admin_force_delete_impact('product',prod::text);
 assert result->>'product'='Validación aislada Ñandú', 'product name';
 assert jsonb_array_length(result->'references')>0, 'product references';
 result := admin_force_delete_impact('variant',variant::text);
 assert result->>'sku'=tag, 'variant SKU';
 assert result->>'confirmation'='ELIMINAR VARIANTE '||tag, 'variant typed confirmation';
 insert into audit67_results values('force_delete_impact',jsonb_build_object('purchaseProjection',true,'subsequentSales',true,'productReferences',true,'variantSku',true,'typedConfirmation',true,'deletionsExecuted',false));
 set constraints all immediate;
end $audit$;
select * from audit67_results;
rollback;



