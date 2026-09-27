/**
 * Reemplaza @/app/api/admin/clientes/_auth SÓLO dentro del arnés: el actor es
 * el super_admin indicado explícitamente (verificado contra profiles por
 * run.ts). Las rutas reales corren sin ningún otro cambio.
 */

import { createAdminClient } from "../../../lib/supabase/admin.ts"
import { harnessState } from "../harness-state.ts"

function auth() {
  const actor = harnessState().actor
  if (!actor) {
    return { error: Response.json({ error: "Arnés sin actor configurado." }, { status: 401 }) }
  }
  return {
    admin: createAdminClient(),
    user: { id: actor.id, email: actor.email },
    profile: { id: actor.id, email: actor.email, rol: actor.rol },
  }
}

export async function requireAdmin() {
  return auth()
}

export async function requireOperator() {
  return auth()
}
