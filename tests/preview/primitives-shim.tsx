/**
 * Preview-only stand-in for `@deepseek-ai/dsh-client-ui-primitives`: the REAL DSH components
 * (compiled from the deepseek-harness sources with their CSS modules) for everything the plugin
 * renders, plus a plain-text MarkdownText (the real one pulls the whole markdown stack).
 */

export { StateDot } from '@dsh-primitives/StateDot.tsx'
export { Button } from '@dsh-primitives/Button.tsx'
export { DisclosureRow } from '@dsh-primitives/DisclosureRow.tsx'
export { TextShimmer } from '@dsh-primitives/TextShimmer.tsx'
export {
  IconChevronRightOutlineRegular,
  IconLayersOutlineRegular,
  IconRefreshOutlineRegular,
  IconStopFillRegular,
} from '@dsh-primitives/icons/index.tsx'

export function MarkdownText({ text }: { text: string }) {
  return <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
}
