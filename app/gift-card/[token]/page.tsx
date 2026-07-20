import { GiftCardClaimClient } from "./gift-card-claim-client"

export default async function GiftCardClaimPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return <GiftCardClaimClient token={token} />
}
