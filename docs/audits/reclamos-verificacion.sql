-- Sólo lectura. Ejecutar con: supabase db query --linked --file <este archivo>.
begin read only;
do $$
declare v_table text; v_rpc regprocedure; v_role text;
begin
  foreach v_table in array array['order_claims','order_claim_messages','order_claim_files','order_claim_operations'] loop
    if not exists(select 1 from pg_class where oid=('public.'||v_table)::regclass and relrowsecurity) then raise exception 'RLS_MISSING: %',v_table; end if;
    foreach v_role in array array['anon','authenticated'] loop
      if has_table_privilege(v_role,'public.'||v_table,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then raise exception 'UNSAFE_TABLE_GRANT: % %',v_table,v_role; end if;
    end loop;
  end loop;
  foreach v_rpc in array array[
    'public.begin_order_claim_operation(uuid,uuid,bigint,text,text[],text)'::regprocedure,
    'public.commit_customer_order_claim(uuid,uuid,jsonb,jsonb)'::regprocedure,
    'public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb)'::regprocedure,
    'public.commit_order_refund_proof(uuid,uuid,jsonb)'::regprocedure,
    'public.process_claim_return_inventory(bigint,bigint,bigint,integer,integer,text,uuid)'::regprocedure,
    'public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[])'::regprocedure
  ] loop
    if has_function_privilege('anon',v_rpc,'EXECUTE') or has_function_privilege('authenticated',v_rpc,'EXECUTE') or not has_function_privilege('service_role',v_rpc,'EXECUTE') then raise exception 'UNSAFE_RPC_GRANT: %',v_rpc; end if;
    if not exists(select 1 from pg_proc where oid=v_rpc and prosecdef and 'search_path=public'=any(proconfig)) then raise exception 'UNSAFE_RPC_CONFIG: %',v_rpc; end if;
  end loop;
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(v_role,'public.approve_order_claim_product_change(bigint,uuid)','EXECUTE') then raise exception 'LEGACY_RPC_EXPOSED'; end if;
    if has_function_privilege(v_role,'public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text)','EXECUTE') then raise exception 'LEGACY_FISCAL_RPC_EXPOSED'; end if;
  end loop;
  if not exists(select 1 from storage.buckets where id='order-claim-evidence' and not public and file_size_limit=41943040 and cardinality(allowed_mime_types)=8) then raise exception 'UNSAFE_EVIDENCE_BUCKET'; end if;
  if exists(select 1 from storage.buckets where id='payment-proofs' and public) then raise exception 'PUBLIC_PROOFS'; end if;
  if not exists(select 1 from pg_indexes where schemaname='public' and indexname='order_claims_one_active_per_order_idx' and indexdef like 'CREATE UNIQUE INDEX%') then raise exception 'ACTIVE_CLAIM_UNIQUENESS_MISSING'; end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.order_claims'::regclass and tgfoid='public.touch_order_claim_updated_at()'::regprocedure and tgenabled<>'D') then raise exception 'VERSION_TRIGGER_MISSING'; end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgfoid='public.guard_profile_privilege_assignment()'::regprocedure and tgenabled<>'D') then raise exception 'PROFILE_GUARD_MISSING'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='order_claims' and column_name in ('refund_account_holder','refund_account_identifier','refund_bank','refund_amount_confirmed','refund_details_submitted_at','refund_completed_at','refund_completed_by'))<>7 then raise exception 'REFUND_COLUMNS_MISSING'; end if;
end $$;

select jsonb_build_object(
  'result','catalog_assertions_passed',
  'counts',(select jsonb_build_object('claims',(select count(*) from public.order_claims),'messages',(select count(*) from public.order_claim_messages),'files',(select count(*) from public.order_claim_files),'objects_without_metadata',(select count(*) from storage.objects o where bucket_id='order-claim-evidence' and not exists(select 1 from public.order_claim_files f where f.file_path='order-claim-evidence/'||o.name or f.file_path=o.name)))),
  'migrations',(select jsonb_agg(to_jsonb(m)) from (select version,name from supabase_migrations.schema_migrations where version>='20260905130000' order by version) m),
  'policies',(select jsonb_agg(to_jsonb(p)) from (select tablename,policyname,roles,cmd,qual,with_check from pg_policies where tablename like 'order_claim%' or schemaname='storage') p),
  'grants',(select jsonb_agg(to_jsonb(g)) from (select table_name,grantee,string_agg(privilege_type,',' order by privilege_type) as privileges from information_schema.role_table_grants where table_schema='public' and table_name like 'order_claim%' and grantee in ('anon','authenticated','service_role','PUBLIC') group by table_name,grantee) g),
  'triggers',(select jsonb_agg(to_jsonb(t)) from (select tgrelid::regclass::text as table_name,tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger where not tgisinternal and tgrelid in ('public.order_claims'::regclass,'public.order_claim_messages'::regclass,'public.profiles'::regclass)) t),
  'constraints',(select jsonb_agg(to_jsonb(c)) from (select conrelid::regclass::text as table_name,conname,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('public.order_claims'::regclass,'public.order_claim_messages'::regclass,'public.order_claim_files'::regclass,'public.order_claim_operations'::regclass)) c),
  'indexes',(select jsonb_agg(to_jsonb(i)) from (select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename like 'order_claim%') i)
) as verification;
commit;
