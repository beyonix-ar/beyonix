"use client"

import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react"
import { createPortal } from "react-dom"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"

export const adminPageClassName = "space-y-6 p-4 sm:p-6 lg:p-8"

const adminSurfaceClassName = "admin-ds-surface"

export const adminCardClassName = cn("admin-ds-card", adminSurfaceClassName)

export const adminControlClassName =
  "admin-control-input admin-ds-control h-11 w-full px-4 text-sm font-medium outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45"

const adminButtonBaseClassName =
  "admin-ds-button inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 px-4 py-2 text-sm font-black outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45"

const adminButtonVariantClassNames = {
  primary: "admin-ds-button-primary",
  secondary: "admin-ds-button-secondary",
  ghost: "admin-ds-button-ghost",
  destructive: "admin-ds-button-destructive",
} as const

const adminButtonSizeClassNames = {
  sm: "min-h-8 px-3 py-1.5 text-xs",
  md: "min-h-10 px-4 py-2 text-sm",
  lg: "min-h-11 px-5 py-2.5 text-sm",
  icon: "size-10 min-h-0 px-0 py-0",
} as const

type AdminTone = "neutral" | "info" | "success" | "warning" | "danger"

const adminToneClassNames: Record<AdminTone, string> = {
  neutral: "admin-ds-tone-neutral",
  info: "admin-ds-tone-info",
  success: "admin-ds-tone-success",
  warning: "admin-ds-tone-warning",
  danger: "admin-ds-tone-danger",
}

interface AdminSelectProps {
  title: string
  value: string
  children: ReactNode
  ariaLabel?: string
  compact?: boolean
  centered?: boolean
  disabled?: boolean
  triggerClassName?: string
  leadingIcon?: ReactNode
  onChange: (value: string) => void
}

interface AdminTextInputProps {
  title: string
  value: string
  placeholder: string
  ariaLabel?: string
  icon?: ReactNode
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"]
  type?: InputHTMLAttributes<HTMLInputElement>["type"]
  disabled?: boolean
  className?: string
  onChange: (value: string) => void
}

interface AdminTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  title: string
  value: string
  ariaLabel?: string
  onChange: (value: string) => void
}

interface AdminButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof adminButtonVariantClassNames
  size?: keyof typeof adminButtonSizeClassNames
  icon?: ReactNode
}

interface AdminPageHeaderProps {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
  meta?: ReactNode
  className?: string
}

interface AdminSectionProps extends HTMLAttributes<HTMLElement> {
  eyebrow?: string
  title?: string
  description?: string
  actions?: ReactNode
}

interface AdminCardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
}

interface AdminStatCardProps {
  title: string
  value: ReactNode
  helper?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  onClick?: () => void
  tone?: AdminTone
  className?: string
}

interface AdminTableProps extends HTMLAttributes<HTMLDivElement> {
  headers?: ReactNode[]
  columnsClassName?: string
}

interface AdminEmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

interface AdminBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: AdminTone
}

interface AdminModalProps {
  open: boolean
  title: string
  eyebrow?: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}

interface AdminDrawerProps extends AdminModalProps {
  side?: "left" | "right"
}

interface AdminFormFieldProps {
  label: string
  children: ReactNode
  help?: ReactNode
  error?: ReactNode
  className?: string
}

interface AdminInfoBlockProps extends HTMLAttributes<HTMLDivElement> {
  tone?: AdminTone
  icon?: ReactNode
}

interface AdminStatusIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: AdminTone
  pulse?: boolean
}

interface AdminSkeletonProps {
  rows?: number
  className?: string
}

interface AdminPaginationProps {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  className?: string
}

export function AdminSelect({
  title,
  value,
  children,
  ariaLabel,
  compact = false,
  centered = false,
  disabled = false,
  triggerClassName = "",
  leadingIcon,
  onChange,
}: AdminSelectProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [menuPosition, setMenuPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
  })
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = child.props as {
        value?: string | number
        children?: React.ReactNode
      }

      return {
        value: String(props.value ?? ""),
        label: props.children,
      }
    })

  const selectedOption = options.find((option) => option.value === value)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node

      if (
        !wrapperRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)

    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [])

  useEffect(() => {
    if (!open) return

    function updateMenuPosition() {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return

      const menuHeight = Math.min(options.length * 36 + 10, 256)
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < menuHeight && rect.top > menuHeight
      const width = Math.max(rect.width, compact ? 144 : rect.width)
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8)
      )

      setMenuPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - menuHeight - 4)
          : Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 4),
        width,
      })
    }

    updateMenuPosition()
    window.addEventListener("resize", updateMenuPosition)
    window.addEventListener("scroll", updateMenuPosition, true)

    return () => {
      window.removeEventListener("resize", updateMenuPosition)
      window.removeEventListener("scroll", updateMenuPosition, true)
    }
  }, [compact, open, options.length])

  return (
    <div
      ref={wrapperRef}
      className="relative block w-full"
      title={title}
    >
      <button
        type="button"
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`admin-control-select admin-ds-control relative flex cursor-pointer items-center font-medium outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45 ${triggerClassName} ${
          centered ? "justify-center" : "justify-between"
        } ${
          compact
            ? "h-8 w-full min-w-0 gap-1 px-2 text-11px"
            : "h-11 w-full gap-3 px-4 text-sm"
        }`}
      >
        <span className={`flex min-w-0 items-center gap-2 truncate ${centered ? "px-4 text-center" : ""}`}>
          {leadingIcon && <span className="shrink-0">{leadingIcon}</span>}
          <span className="truncate">{selectedOption?.label}</span>
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-beyonix-sky/75 transition-transform ${
            centered ? "absolute right-2" : ""
          } ${centered ? "" : "mr-1"} ${open ? "rotate-180" : ""}`}
        />
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel ?? title}
          className="admin-ds-select-menu fixed z-100 max-h-64 overflow-hidden p-1"
            style={{
              left: menuPosition.left,
              top: menuPosition.top,
              width: menuPosition.width,
            }}
          >
            <div className={`admin-select-scrollbar overflow-y-auto py-1 pr-1 ${compact ? "max-h-48" : "max-h-60"}`}>
              {options.map((option) => {
                const selected = option.value === value

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(option.value)
                      setOpen(false)
                    }}
                    className={`flex w-full cursor-pointer items-center justify-between rounded-xl text-left font-medium transition-colors ${
                      compact ? "h-8 gap-2 px-2.5 text-xs" : "h-9 gap-3 px-3 text-sm"
                    } ${
                      selected
                        ? "admin-ds-select-option-selected"
                        : "admin-ds-select-option"
                    }`}
                  >
                    <span className="truncate">{option.label}</span>
                    {selected && <Check className="size-3.5 text-beyonix-sky" />}
                  </button>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

export function AdminTextInput({
  title,
  value,
  placeholder,
  ariaLabel,
  icon,
  inputMode,
  type = "text",
  disabled = false,
  className,
  onChange,
}: AdminTextInputProps) {
  return (
    <label className="relative block" title={title}>
      {icon && (
        <span className="pointer-events-none absolute left-4 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center text-white/38">
          {icon}
        </span>
      )}
      <input
        type={type}
        title={title}
        aria-label={ariaLabel ?? title}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(adminControlClassName, icon && "pl-11", className)}
      />
    </label>
  )
}

export function AdminTextarea({
  title,
  value,
  ariaLabel,
  className,
  onChange,
  ...props
}: AdminTextareaProps) {
  return (
    <textarea
      title={title}
      aria-label={ariaLabel ?? title}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        adminControlClassName,
        "min-h-28 resize-none py-3 leading-6",
        className,
      )}
      {...props}
    />
  )
}

export function AdminButton({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...props
}: AdminButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        adminButtonBaseClassName,
        adminButtonVariantClassNames[variant],
        adminButtonSizeClassNames[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}

export function AdminPrimaryButton(props: Omit<AdminButtonProps, "variant">) {
  return <AdminButton variant="primary" {...props} />
}

export function AdminSecondaryButton(props: Omit<AdminButtonProps, "variant">) {
  return <AdminButton variant="secondary" {...props} />
}

export function AdminGhostButton(props: Omit<AdminButtonProps, "variant">) {
  return <AdminButton variant="ghost" {...props} />
}

export function AdminDangerButton(props: Omit<AdminButtonProps, "variant">) {
  return <AdminButton variant="destructive" {...props} />
}

export function AdminPageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: AdminPageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            {eyebrow}
          </p>
        )}
        <h1 className="text-3xl font-black text-white">{title}</h1>
        {description && (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/66">
            {description}
          </p>
        )}
        {meta}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}

export function AdminSection({
  eyebrow,
  title,
  description,
  actions,
  className,
  children,
  ...props
}: AdminSectionProps) {
  return (
    <section
      className={cn(adminCardClassName, "p-4 sm:p-5", className)}
      {...props}
    >
      {(title || eyebrow || description || actions) && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {eyebrow && (
              <p className="mb-1 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
                {eyebrow}
              </p>
            )}
            {title && <h2 className="text-lg font-black text-white">{title}</h2>}
            {description && (
              <p className="mt-1 text-sm leading-6 text-white/58">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function AdminCard({
  interactive = false,
  className,
  children,
  ...props
}: AdminCardProps) {
  return (
    <div
      className={cn(
        adminCardClassName,
        "p-4",
        interactive &&
          "admin-ds-card-interactive transition hover:-translate-y-0.5 hover:border-beyonix-sky/38",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function AdminStatCard({
  title,
  value,
  helper,
  icon,
  action,
  onClick,
  tone = "info",
  className,
}: AdminStatCardProps) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan/85">
            {title}
          </p>
          <p className="mt-3 wrap-break-word text-2xl font-black leading-tight text-white">
            {value}
          </p>
          {helper && (
            <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-white/58">
              {helper}
            </p>
          )}
        </div>
        {icon && (
          <span
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-xl border",
              adminToneClassNames[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>
      {action && <div className="mt-4">{action}</div>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        title={`Abrir ${title}`}
        aria-label={`Abrir ${title}`}
        onClick={onClick}
        className={cn(
          adminCardClassName,
          "admin-ds-stat-card group min-h-32 cursor-pointer p-5 text-left transition hover:-translate-y-0.5 hover:border-beyonix-sky/38",
          className,
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <AdminCard className={cn("admin-ds-stat-card min-h-32 p-5", className)}>
      {content}
    </AdminCard>
  )
}

export function AdminToolbar({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function AdminFiltersBar({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(adminCardClassName, "p-4", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function AdminSearchInput(props: Omit<AdminTextInputProps, "icon">) {
  return <AdminTextInput icon={<Search className="size-4" />} {...props} />
}

export function AdminTable({
  headers,
  columnsClassName,
  className,
  children,
  ...props
}: AdminTableProps) {
  return (
    <div
      className={cn(
        "admin-ds-table overflow-hidden",
        className,
      )}
      {...props}
    >
      {headers && (
        <div
          className={cn(
            "admin-ds-table-header hidden gap-3 px-4 py-3 text-10px font-black uppercase tracking-widest xl:grid",
            columnsClassName,
          )}
        >
          {headers.map((header, index) => (
            <span key={index}>{header}</span>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}

export function AdminEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: AdminEmptyStateProps) {
  return (
    <div
      className={cn(
        adminCardClassName,
        "px-5 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl border border-beyonix-blue-light/22 bg-beyonix-blue/20 text-white/72">
          {icon}
        </span>
      )}
      <p className="text-sm font-black text-white">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-white/50">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function AdminBadge({
  tone = "neutral",
  className,
  children,
  ...props
}: AdminBadgeProps) {
  return (
    <span
      className={cn(
        "admin-ds-badge inline-flex w-fit items-center gap-1.5 px-2.5 py-1 text-10px font-black uppercase tracking-widest",
        adminToneClassNames[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export function AdminModal({
  open,
  title,
  eyebrow,
  description,
  children,
  footer,
  onClose,
}: AdminModalProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/86 px-4 backdrop-blur-sm">
      <div className={cn(adminCardClassName, "w-full max-w-xl p-5 shadow-2xl shadow-black")}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && (
              <p className="mb-1 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
                {eyebrow}
              </p>
            )}
            <h2 className="text-2xl font-black text-white">{title}</h2>
            {description && (
              <p className="mt-2 text-sm leading-6 text-white/58">
                {description}
              </p>
            )}
          </div>
          <AdminGhostButton
            title="Cerrar"
            aria-label="Cerrar"
            size="icon"
            onClick={onClose}
          >
            <X className="size-4" />
          </AdminGhostButton>
        </div>
        {children}
        {footer && <div className="mt-6">{footer}</div>}
      </div>
    </div>
  )
}

export function AdminDrawer({
  open,
  title,
  eyebrow,
  description,
  children,
  footer,
  side = "right",
  onClose,
}: AdminDrawerProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-100 bg-black/82 backdrop-blur-sm">
      <aside
        className={cn(
          adminCardClassName,
          "absolute top-0 h-full w-full max-w-xl rounded-none p-5 shadow-2xl shadow-black",
          side === "right" ? "right-0" : "left-0",
        )}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && (
              <p className="mb-1 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
                {eyebrow}
              </p>
            )}
            <h2 className="text-2xl font-black text-white">{title}</h2>
            {description && (
              <p className="mt-2 text-sm leading-6 text-white/58">
                {description}
              </p>
            )}
          </div>
          <AdminGhostButton
            title="Cerrar"
            aria-label="Cerrar"
            size="icon"
            onClick={onClose}
          >
            <X className="size-4" />
          </AdminGhostButton>
        </div>
        <div className="admin-ds-drawer-body custom-scrollbar overflow-y-auto pr-1">
          {children}
        </div>
        {footer && <div className="mt-4 border-t border-white/8 pt-4">{footer}</div>}
      </aside>
    </div>
  )
}

export function AdminFormField({
  label,
  children,
  help,
  error,
  className,
}: AdminFormFieldProps) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-2 block text-11px font-black uppercase tracking-widest text-white/48">
        {label}
      </span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs leading-5 text-red-200">
          {error}
        </span>
      ) : help ? (
        <span className="mt-1.5 block text-xs leading-5 text-white/42">
          {help}
        </span>
      ) : null}
    </label>
  )
}

export function AdminInfoBlock({
  tone = "info",
  icon,
  className,
  children,
  ...props
}: AdminInfoBlockProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium",
        adminToneClassNames[tone],
        className,
      )}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function AdminStatusIndicator({
  tone = "info",
  pulse = false,
  className,
  children,
  ...props
}: AdminStatusIndicatorProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-xs font-black uppercase tracking-widest",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" && "bg-emerald-300",
          tone === "warning" && "bg-amber-300",
          tone === "danger" && "bg-red-300",
          tone === "info" && "bg-beyonix-sky",
          tone === "neutral" && "bg-white/38",
          pulse && "animate-pulse",
        )}
      />
      {children}
    </span>
  )
}

export function AdminSkeleton({ rows = 3, className }: AdminSkeletonProps) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="admin-ds-skeleton h-16 animate-pulse"
        />
      ))}
    </div>
  )
}

export function AdminPagination({
  page,
  pageCount,
  onPageChange,
  className,
}: AdminPaginationProps) {
  const safePageCount = Math.max(1, pageCount)
  const safePage = Math.min(Math.max(1, page), safePageCount)

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-beyonix-blue-light/18 bg-black/30 px-3 py-2",
        className,
      )}
    >
      <span className="text-xs font-bold text-white/50">
        Página {safePage} de {safePageCount}
      </span>
      <div className="flex items-center gap-2">
        <AdminSecondaryButton
          title="Página anterior"
          aria-label="Página anterior"
          size="icon"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          <ChevronLeft className="size-4" />
        </AdminSecondaryButton>
        <AdminSecondaryButton
          title="Página siguiente"
          aria-label="Página siguiente"
          size="icon"
          disabled={safePage >= safePageCount}
          onClick={() => onPageChange(safePage + 1)}
        >
          <ChevronRight className="size-4" />
        </AdminSecondaryButton>
      </div>
    </div>
  )
}
