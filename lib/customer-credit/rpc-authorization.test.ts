import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const root = process.cwd()
const migration = readFileSync(join(root,
  "supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql",
), "utf8").replaceAll("\r\n", "\n")

// Huellas de pg_get_functiondef, consultadas en remoto (sólo catálogo) el
// 2026-09-11; normalizadas a LF. No provienen de supabase/sql histórico.
// MD5 sólo compara contenido, no se usa como mecanismo de seguridad.
const baseline = {
  get_customer_credit_balance: "95cd0d4d806a3c6e339ca3fb71f5922c",
  create_customer_credit_movement: "705175ab4239fdfe827794c19a5c60ed",
  apply_customer_credit_to_order: "df1933700a5943cdededc0fe8a1d1689",
  reverse_customer_credit_for_order: "4cb0a86bc6a0352c0d15b5de893bbf4b",
  resolve_customer_credit_topup: "8984a94c012e82a584a4ef98cb9360f3",
  credit_customer_credit_topup_from_mercadopago: "0c02cd281001d7b2a1b0c222ed34c8ac",
}

const functions = [...migration.matchAll(
  /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$function\$[\s\S]*?\$function\$;/g,
)].map(([definition, name]) => ({ name, definition }))

function originalCondition(name: string) {
  return "if auth.role() <> 'service_role'" +
    (name === "get_customer_credit_balance" ? "\n     and auth.uid() is distinct from p_user_id" : "") +
    (name === "credit_customer_credit_topup_from_mercadopago" ? "" :
      "\n     and public.current_user_role() not in ('admin', 'super_admin')") + " then"
}

function authorizationGuard(definition: string) {
  const guard = definition.match(/if auth\.role\(\)[\s\S]*?end if;/)?.[0]
  assert.ok(guard, "Debe existir una guarda de autorización explícita")
  return guard
}

test("la migración conserva exactamente la lógica remota salvo autorización y search_path", () => {
  assert.deepEqual(functions.map(({ name }) => name).sort(), Object.keys(baseline).sort())
  for (const [name, hash] of Object.entries(baseline)) {
    const definition = functions.find((entry) => entry.name === name)?.definition
    assert.ok(definition)
    assert.match(definition, /SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public', 'pg_temp'/)
    assert.match(authorizationGuard(definition), /^if auth\.role\(\) is distinct from 'service_role' then/)
    const restored = definition
      .replace("if auth.role() is distinct from 'service_role' then", originalCondition(name))
      .replace("SET search_path TO 'pg_catalog', 'public', 'pg_temp'", "SET search_path TO 'public'")
      .replace(/;$/, "\n")
    assert.equal(createHash("md5").update(restored).digest("hex"), hash,
      `${name}: firmas, defaults, validaciones, locks, idempotencia y cálculos deben permanecer idénticos`)
  }
  assert.match(migration, /\nbegin;\n/)
  assert.match(migration, /\ncommit;\s*$/)
  assert.doesNotMatch(migration, /\bdrop\s+(?:function|table)|\balter\s+table/i)
})

// No aplica la migración ni ejecuta ninguna RPC financiera. Se prueban sólo
// fragmentos de autorización en funciones booleanas sin tablas/datos de negocio,
// y los GRANT/REVOKE sobre firmas con cuerpos inertes en PostgreSQL en memoria.
test("PostgreSQL: ACL mínimas y guardas fail-closed incluso dentro de SECURITY DEFINER", async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create role unrelated_role;
      create schema auth;
      create function auth.role() returns text language sql stable as $$
        select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
      $$;
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
      $$;
      create function public.current_user_role() returns text language sql stable as $$
        select nullif(current_setting('test.profile_role', true), '')
      $$;
      grant usage on schema auth to anon, authenticated, service_role;
    `)

    await t.test("revoca PUBLIC/anon/authenticated, conserva service_role y al dueño", async () => {
      for (const { definition } of functions) {
        const header = definition.split("AS $function$")[0]
        const inertBody = /RETURNS TABLE/.test(header) ? "begin return; end;" : "begin return null; end;"
        await db.exec(`${header} AS $inert$ ${inertBody} $inert$;`)
      }
      // Reproduce tanto grants explícitos como PUBLIC para cubrir ambos caminos.
      await db.exec("grant execute on all functions in schema public to public, anon, authenticated, service_role")
      const grants = migration.match(/(?:revoke execute|grant execute) on function[\s\S]*?;/g) ?? []
      assert.equal(grants.length, 12)
      await db.exec(grants.join("\n"))
      const permissions = await db.query<{
        proname: string; anon: boolean; authenticated: boolean; service: boolean;
        owner: boolean; unrelated: boolean; public_execute: boolean; path: string[];
      }>(`select p.proname,
        has_function_privilege('anon',p.oid,'EXECUTE') anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') service,
        has_function_privilege(p.proowner,p.oid,'EXECUTE') owner,
        has_function_privilege('unrelated_role',p.oid,'EXECUTE') unrelated,
        exists(select 1 from aclexplode(p.proacl) where grantee=0 and privilege_type='EXECUTE') public_execute,
        p.proconfig path
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname <> 'current_user_role'`)
      assert.equal(permissions.rows.length, 6)
      for (const row of permissions.rows) {
        assert.deepEqual(row, { proname: row.proname, anon: false, authenticated: false,
          service: true, owner: true, unrelated: false, public_execute: false,
          path: ["search_path=pg_catalog, public, pg_temp"] })
      }
    })

    await t.test("reproduce el fail-open anterior sin ejecutar operaciones financieras", async () => {
      await db.exec(`create function public.previous_authorization_probe() returns boolean
        language plpgsql security definer as $$ begin
        ${originalCondition("create_customer_credit_movement")}
          return false;
        end if;
        return true;
        end $$;`)
      await db.query("select set_config('request.jwt.claims',$1,false), set_config('test.profile_role','',false)",
        [JSON.stringify({ role: "anon" })])
      await db.exec("set role anon")
      const result = await db.query<{ allowed: boolean }>("select public.previous_authorization_probe() allowed")
      assert.equal(result.rows[0].allowed, true, "anon sin uid/perfil evita el rechazo anterior")
      await db.exec("reset role")
    })

    await t.test("las seis guardas rechazan roles NULL y sesiones normales, con o sin uid/perfil", async () => {
      for (const { name, definition } of functions) {
        await db.exec(`create or replace function public.authorization_probe() returns boolean
          language plpgsql security definer set search_path = pg_catalog, public, pg_temp
          as $$ begin ${authorizationGuard(definition)} return true; end $$;`)
        for (const role of [null, "anon", "authenticated", "service_role"]) {
          for (const profile of [null, "cliente", "operador", "admin", "super_admin"]) {
            for (const uid of [null, "00000000-0000-0000-0000-000000000001"]) {
              await db.query("select set_config('request.jwt.claims',$1,false), set_config('test.profile_role',$2,false)",
                [JSON.stringify({ role, sub: uid }), profile ?? ""])
              const databaseRole = role === "service_role" ? "service_role" : role === "authenticated" ? "authenticated" : "anon"
              await db.exec(`set role ${databaseRole}`)
              if (role === "service_role") {
                const result = await db.query<{ allowed: boolean }>("select public.authorization_probe() allowed")
                assert.equal(result.rows[0].allowed, true, `${name}: service_role admite uid/perfil NULL`)
              } else {
                await assert.rejects(db.query("select public.authorization_probe()"),
                  /No tenés permisos|SERVICE_ROLE_REQUIRED/, `${name}: ${role}/${profile}/${uid}`)
              }
              await db.exec("reset role")
            }
          }
        }
      }
    })

    await t.test("un wrapper DEFINER no convierte anon en service_role", async () => {
      await db.exec(`create function public.wrapper_authorization_probe() returns boolean
        language plpgsql security definer set search_path = pg_catalog, public, pg_temp
        as $$ begin return public.authorization_probe(); end $$;`)
      for (const role of [null, "anon", "authenticated", "service_role"]) {
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role })])
        await db.exec(role === "service_role" ? "set role service_role" : "set role anon")
        if (role === "service_role") {
          const result = await db.query<{ allowed: boolean }>("select public.wrapper_authorization_probe() allowed")
          assert.equal(result.rows[0].allowed, true)
        } else {
          await assert.rejects(db.query("select public.wrapper_authorization_probe()"), /SERVICE_ROLE_REQUIRED/)
        }
        await db.exec("reset role")
      }
    })
  } finally {
    await db.close()
  }
})

test("las RPC base sólo tienen consumidores directos en el módulo server-only", () => {
  const rpcNames = Object.keys(baseline).slice(0, 4)
  const consumers: string[] = []
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(path, "utf8")
        if (rpcNames.some((name) => source.includes(`"${name}"`) || source.includes(`'${name}'`))) {
          consumers.push(relative(root, path).replaceAll("\\", "/"))
        }
      }
    }
  }
  for (const directory of ["app", "components", "context", "hooks", "lib"]) scan(join(root, directory))
  assert.deepEqual(consumers, ["lib/customer-credit/server.ts"])
  const server = readFileSync(join(root, consumers[0]), "utf8")
  assert.match(server, /^import "server-only"/)
  const admin = readFileSync(join(root, "lib/supabase/admin.ts"), "utf8")
  assert.match(admin, /createClient\(url, serviceRoleKey/)
  assert.match(admin, /SUPABASE_SERVICE_ROLE_KEY/)
  const auth = readFileSync(join(root, "lib/auth/admin-api.ts"), "utf8")
  assert.match(auth, /const admin = createAdminClient\(\)/)
  assert.match(auth, /getClaims\(token\)/)
  assert.match(auth, /allowedRoles\.includes\(role\)/)
})
