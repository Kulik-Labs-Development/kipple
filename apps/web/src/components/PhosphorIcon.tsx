// Phosphor icon wrapper (issue #7 iconography).
// @phosphor-icons/web is a ligature font system: per-weight CSS (imported
// here — Vite bundles the woff2 assets, so no CDN; self-host friendly) plus
// `.ph-<weight>.ph-<name>` classes. Light is the base weight (one place for
// the weight decision); `filled` swaps the glyph to the fill weight for
// state toggles (the notification bell: filled = unread, outline = cleared).
import '@phosphor-icons/web/light'
import '@phosphor-icons/web/fill'

const SIZE_CLASSES = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
} as const

interface PhosphorIconProps {
  /** Phosphor icon name without the `ph-` prefix (e.g. "bell"). */
  name: string
  /** Render the fill weight instead of light (state toggle). */
  filled?: boolean
  /** Omit to inherit the surrounding font size. */
  size?: keyof typeof SIZE_CLASSES
  className?: string
  /** When set, the icon is exposed to assistive tech as an image with this
   *  label (icon-only buttons); otherwise it is decorative (aria-hidden). */
  label?: string
  /** For one-shot animations (bell arrival wiggle) — cleared on
   *  animationend so the next arrival re-fires. */
  onAnimationEnd?: () => void
}

export function PhosphorIcon({
  name,
  filled = false,
  size,
  className = '',
  label,
  onAnimationEnd,
}: PhosphorIconProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onAnimationEnd={onAnimationEnd}
      className={`inline-block ${filled ? 'ph-fill' : 'ph-light'} ph-${name} ${
        size ? SIZE_CLASSES[size] : ''
      } ${className}`}
    />
  )
}
