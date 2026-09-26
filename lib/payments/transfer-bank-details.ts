import { TRANSFER_ACCOUNT_HOLDER, TRANSFER_ALIAS, TRANSFER_CVU } from "./transfer.ts"

export interface TransferBankDetails {
  alias: string
  cvu: string
  accountHolder: string
}

/**
 * Datos bancarios de BEYONIX. Los entrega el servidor recién después de
 * validar y guardar los datos del titular que va a transferir
 * (/api/transferencia/[orderId]/titular): sin esos datos una transferencia
 * no podría atribuirse al pedido.
 */
export function getTransferBankDetails(): TransferBankDetails {
  return {
    alias: TRANSFER_ALIAS.toUpperCase(),
    cvu: TRANSFER_CVU,
    accountHolder: TRANSFER_ACCOUNT_HOLDER,
  }
}
