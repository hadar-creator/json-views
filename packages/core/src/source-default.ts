import { compileJsonViewMetadata } from './metadata.js'
import { isJsonViewTableCandidate } from './table-suitability.js'

/** Counts scalar values, stopping once the count passes the limit. */
function countLeaves(root: unknown, limit: number): number {
  let leaves = 0
  const pending: unknown[] = [root]
  while (pending.length) {
    const value = pending.pop()
    if (value !== null && typeof value === 'object') pending.push(...Object.values(value))
    else if ((leaves += 1) > limit) break
  }
  return leaves
}

/** Initial presentation only. Never changes a user's selection during edits. */
export function prefersSource(content: string, metadata?: unknown): boolean {
  try {
    const root: unknown = JSON.parse(content)
    // Every scalar takes a pretty-printed line of its own, so a document with
    // more than 100 of them fails the size check below without a compile.
    if (countLeaves(root, 100) > 100) return false
    const formatted = JSON.stringify(root, null, 2)
    const lines = formatted.split('\n').length
    if (formatted.length > 8000 || lines > 100) return false
    const compiled = compileJsonViewMetadata(root, undefined, metadata === undefined ? {} : { metadata })
    if (compiled.metadataSource !== 'inferred' || compiled.views.length || isJsonViewTableCandidate(root)) return false
    const entries = root !== null && typeof root === 'object' ? Object.values(root) : []
    // Dictionaries now fall back to properties when their fields differ. Keep
    // that structured presentation instead of switching them to source.
    if (!Array.isArray(root) && entries.length >= 2
      && entries.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) return false
    // A compact root with little visible information is easier to read whole
    // than by opening each nested value, even when nesting is only one level.
    if (entries.length <= 5 && formatted.length <= 3000 && lines <= 40
      && entries.some((value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0
        // Flat lists are simple field values, not structural nesting.
        && (!Array.isArray(value) || value.some((item) => item !== null && typeof item === 'object')))) return true
    let leaves = 0
    let hidden = 0
    const visit = (value: unknown, depth: number): void => {
      if (value !== null && typeof value === 'object') Object.values(value).forEach((child) => visit(child, depth + 1))
      else { leaves++; if (depth >= 3) hidden++ }
    }
    visit(root, 0)
    return leaves > 0 && hidden / leaves >= 0.6
  } catch { return false }
}
