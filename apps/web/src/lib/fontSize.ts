// Inline font-size marks, rendered as utility classes (not inline styles)
// so the sanitizer's class allowlist is the only surface that needs trust.
// See apps/web/src/index.css for the .fs-* definitions.
import { Mark } from '@tiptap/core'

export const FONT_SIZE_CLASSES = ['fs-sm', 'fs-base', 'fs-lg', 'fs-xl'] as const
export type FontSizeClass = (typeof FONT_SIZE_CLASSES)[number]

export const FontSize = Mark.create({
  name: 'fontSize',

  addAttributes() {
    return {
      class: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const classes = Array.from(element.classList)
          return FONT_SIZE_CLASSES.find((c) => classes.includes(c)) ?? null
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.class ? { class: String(attributes.class) } : {},
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span',
        getAttrs: (node: HTMLElement) =>
          FONT_SIZE_CLASSES.some((c) => Array.from(node.classList).includes(c)) ? {} : null,
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0]
  },
})
