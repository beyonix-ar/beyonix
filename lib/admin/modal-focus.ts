const selector = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const stack: HTMLElement[] = []

export function activateModalFocus(dialog: HTMLElement, close: () => void) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  stack.push(dialog)
  const isVisible = (element: HTMLElement) => {
    for (let current: HTMLElement | null = element; current && current !== dialog; current = current.parentElement) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current)
      if (style?.display === "none" || style?.visibility === "hidden") return false
    }
    return true
  }
  const controls = () => [...dialog.querySelectorAll<HTMLElement>(selector)]
    .filter((element) => !element.closest('[hidden],[inert],[aria-hidden="true"]') && !element.matches(":disabled") && element.tabIndex >= 0 && isVisible(element))
  const first = () => (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? controls()[0] ?? dialog).focus({ preventScroll: true })
  first()
  const keydown = (event: KeyboardEvent) => {
    if (stack.at(-1) !== dialog) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === "Tab") {
      const items = controls()
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (!items.length || index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault()
        ;(event.shiftKey ? items.at(-1) ?? dialog : items[0] ?? dialog).focus({ preventScroll: true })
      }
    }
  }
  const focusin = (event: FocusEvent) => {
    if (stack.at(-1) === dialog && !dialog.contains(event.target as Node)) first()
  }
  document.addEventListener("keydown", keydown)
  document.addEventListener("focusin", focusin)
  return () => {
    document.removeEventListener("keydown", keydown)
    document.removeEventListener("focusin", focusin)
    stack.splice(stack.indexOf(dialog), 1)
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }
}
