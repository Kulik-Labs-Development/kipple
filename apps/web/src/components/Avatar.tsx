import { useState } from 'react'

const SIZES = {
  sm: 'h-4 w-4 text-[9px]',
  md: 'h-6 w-6 text-[11px]',
} as const

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2)
  const value = parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
  return value || '?'
}

// A user avatar that degrades to an initial chip: when `src` is set (the user
// has uploaded one) it renders the image; a missing/unreachable image (e.g. a
// contact author with no staff avatar route) falls back to the chip, so the
// feed never shows a broken image.
export function Avatar({
  src,
  name,
  size = 'md',
}: {
  src?: string | null
  name: string
  size?: keyof typeof SIZES
}) {
  const [failed, setFailed] = useState(false)
  const dim = SIZES[size]
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className={`${dim} shrink-0 rounded-full border border-line object-cover`}
      />
    )
  }
  return (
    <span
      className={`${dim} flex shrink-0 items-center justify-center rounded-full border border-line bg-panel uppercase leading-none text-dim`}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}
