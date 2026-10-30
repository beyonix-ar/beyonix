import { supabase } from "@/lib/supabase/client"
import type {
  ReservationAbuseAccount,
  ReservationAbuseDetail,
  ReservationBlockAction,
  ReservationIpBlock,
} from "@/lib/admin/reservation-abuse"

const ENDPOINT = "/api/admin/clientes/reservas"

async function adminRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...init?.headers,
    },
  })
  const data = (await response.json().catch(() => null)) as ({ error?: string } & T) | null
  if (!response.ok || !data) {
    throw new Error(data?.error || "No se pudo completar la acción. Intentá de nuevo.")
  }
  return data
}

export function fetchReservationAbuseOverview() {
  return adminRequest<{ accounts: ReservationAbuseAccount[]; ipBlocks: ReservationIpBlock[] }>(ENDPOINT)
}

export async function fetchReservationAbuseDetail(userId: string) {
  const { detail } = await adminRequest<{ detail: ReservationAbuseDetail }>(
    `${ENDPOINT}?userId=${encodeURIComponent(userId)}`,
  )
  return detail
}

export async function setReservationBlock(userId: string, action: ReservationBlockAction, reason?: string) {
  await adminRequest<{ ok: true }>(ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ action, userId, reason }),
  })
}

export async function setReservationIpBlock(ip: string, blocked: boolean, reason?: string) {
  await adminRequest<{ ok: true }>(ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ action: blocked ? "block_ip" : "unblock_ip", ip, reason }),
  })
}
