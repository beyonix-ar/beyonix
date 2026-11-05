import { readFileSync } from "node:fs"
import { join } from "node:path"

// La migración C (20261104120000) falla cerrado si falta alguna de las funciones
// con guardas Andreani que reemplaza. Los fixtures parciales que sólo prueban
// En camino / etiquetas no cargan el circuito de cancelación: para ellos se crea,
// SÓLO EN EL TEST, un stub de cada función ausente con sus guardas en la forma
// anterior (como comentario: el reemplazo de C las encuentra exactamente una vez).
// Nunca toca una función existente. La validación real de las 14 guardas sobre
// las definiciones vigentes está en local-delivery-provider-isolation-db.test.ts.

export const MIGRATION_C_PATH = "supabase/migrations/20261104120000_local_delivery_change_guard_and_label_generation.sql"

export type MigrationCGuard = { signature: string; oldText: string; newText: string }

export function readMigrationCGuards(sql = readFileSync(join(process.cwd(), MIGRATION_C_PATH), "utf8")): MigrationCGuard[] {
  return [...sql.matchAll(/\('(public\.[^']+)',\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\)/g)]
    .map(([, signature, oldText, newText]) => ({ signature, oldText, newText }))
}

/** SQL que crea un stub sólo para las funciones con guardas que el fixture no tiene. */
export function missingMigrationCGuardFunctionStubsSql(guards = readMigrationCGuards()): string {
  const bySignature = new Map<string, string[]>()
  for (const guard of guards) bySignature.set(guard.signature, [...(bySignature.get(guard.signature) ?? []), guard.oldText])
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  return [...bySignature].map(([signature, oldTexts]) => {
    const body = `create function ${signature} returns void language plpgsql as $f$ begin\n${oldTexts.map((text) => `-- ${text}`).join("\n")}\nend $f$`
    return `do $stub$ begin if to_regprocedure(${quote(signature)}) is null then execute ${quote(body)}; end if; end $stub$;`
  }).join("\n")
}
