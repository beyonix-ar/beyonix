import { getClientBlockIdentifiers } from "@/lib/clients/client-blocking"

import { requireAdmin } from "../_auth"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request)

  if ("error" in auth) {
    return auth.error
  }

  const { id } = await params
  const body = (await request.json()) as {
    client_risk_status?: string
    admin_note?: string | null
    blocked?: boolean
    blocked_reason?: string | null
  }

  const payload: Record<string, unknown> = {}

  if (body.client_risk_status !== undefined) {
    if (!["normal", "tedioso", "complicado"].includes(body.client_risk_status)) {
      return Response.json({ error: "Clasificacion invalida." }, { status: 400 })
    }

    payload.client_risk_status = body.client_risk_status
  }

  if (body.admin_note !== undefined) {
    payload.admin_note = body.admin_note?.trim() || null
  }

  if (body.blocked !== undefined) {
    payload.blocked_at = body.blocked ? new Date().toISOString() : null
    payload.blocked_reason = body.blocked
      ? body.blocked_reason?.trim() || "Bloqueado desde Clientes"
      : null
    payload.blocked_by = body.blocked ? auth.user.id : null
  }

  if (!Object.keys(payload).length) {
    return Response.json({ error: "No hay cambios para aplicar." }, { status: 400 })
  }

  const { data: profile, error: profileError } = await auth.admin
    .from("profiles")
    .select("id, username, telefono")
    .eq("id", id)
    .single()

  if (profileError || !profile) {
    return Response.json({ error: "Cliente no encontrado." }, { status: 404 })
  }

  const { error: updateError } = await auth.admin
    .from("profiles")
    .update(payload)
    .eq("id", id)

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  if (body.blocked !== undefined) {
    const { data: authUser } = await auth.admin.auth.admin.getUserById(id)
    const identifiers = getClientBlockIdentifiers({
      email: authUser.user?.email,
      username: profile.username,
      phone: profile.telefono,
    })

    if (body.blocked) {
      for (const identifier of identifiers) {
        await auth.admin.from("blocked_client_identifiers").upsert(
          {
            ...identifier,
            reason: body.blocked_reason?.trim() || "Bloqueado desde Clientes",
            source_profile_id: id,
            created_by: auth.user.id,
          },
          { onConflict: "identifier_type,identifier_value" }
        )
      }
    } else if (identifiers.length) {
      for (const identifier of identifiers) {
        await auth.admin
          .from("blocked_client_identifiers")
          .delete()
          .eq("identifier_type", identifier.identifier_type)
          .eq("identifier_value", identifier.identifier_value)
          .eq("source_profile_id", id)
      }
    }
  }

  return Response.json({ ok: true })
}
