import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, getBatchDispatch } from "@/lib/admin/dispatch"

export async function POST(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { requestKey?: string } | null
  if (!body?.requestKey || !/^[0-9a-f-]{36}$/i.test(body.requestKey)) return Response.json({ error: "Solicitud inválida." }, { status: 400 })
  const result = await auth.admin.rpc("create_dispatch_batch", { p_actor_id: auth.user.id, p_request_key: body.requestKey })
  if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  return Response.json(await getBatchDispatch(auth.admin, result.data.id))
}
