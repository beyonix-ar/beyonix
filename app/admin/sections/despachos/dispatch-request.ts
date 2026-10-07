import { supabase } from "@/lib/supabase/client"

export class DispatchRequestError extends Error {
  // false = el servidor respondió (rechazo definitivo); true = no hubo
  // respuesta y el mismo request_key puede reintentarse sin duplicar.
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

export async function dispatchRequest<T>(path: string, body?: object): Promise<T> {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new DispatchRequestError("Tu sesión venció. Volvé a ingresar.", false)
  let response: Response
  try {
    response = await fetch(`/api/admin/dispatch${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    })
  } catch {
    throw new DispatchRequestError("Sin conexión. Reintentá: el escaneo no se duplica.", true)
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new DispatchRequestError(payload?.error ?? "No se pudo completar la operación. Reintentá.", response.status >= 500)
  }
  return response.json() as Promise<T>
}
