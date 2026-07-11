import type { ReactNode } from "react"

import {
  AccountBackButton,
  AccountPageContainer,
  AccountPageHeader,
} from "@/components/account/account-ui"
import { cn } from "@/lib/utils"

export function AccountViewFrame({
  onBack,
  kicker,
  title,
  description,
  children,
  className,
  hideHeading = false,
}: {
  onBack: () => void
  kicker: string
  title: string
  description?: string
  children: ReactNode
  className?: string
  hideHeading?: boolean
}) {
  return (
    <AccountPageContainer className={cn("space-y-4", className)}>
      <AccountBackButton onClick={onBack} />

      {!hideHeading && (
        <AccountPageHeader
          eyebrow={kicker}
          title={title}
          description={description}
        />
      )}

      {children}
    </AccountPageContainer>
  )
}
