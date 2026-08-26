export type CustomerOrderOwnerFields = {
  usuario_id?: string | null
  cliente_email?: string | null
}

export type CustomerIdentity = {
  id: string
  email?: string | null
}

export function isCustomerOrderOwner(
  order: CustomerOrderOwnerFields,
  user: CustomerIdentity,
) {
  if (order.usuario_id) return order.usuario_id === user.id

  const userEmail = user.email?.trim().toLowerCase()
  const orderEmail = order.cliente_email?.trim().toLowerCase()
  return Boolean(userEmail && orderEmail && userEmail === orderEmail)
}
