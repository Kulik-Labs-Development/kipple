import type { InputHTMLAttributes } from 'react'

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string }

export function Field({ label, ...inputProps }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-dim">{label}</span>
      <input
        {...inputProps}
        className="w-full border border-line bg-panel px-3 py-2 text-sm text-fg outline-none placeholder:text-dim focus:border-accent"
      />
    </label>
  )
}
