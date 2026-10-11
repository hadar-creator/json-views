export interface HtmlTemplateNode { tag?: string; text?: string; attrs: Record<string, string>; children: HtmlTemplateNode[]; id: string }
const tags = new Set('main article section header footer nav aside div span h1 h2 h3 h4 h5 h6 p strong em b i small label ul ol li dl dt dd table caption thead tbody tfoot tr td th br hr input textarea progress meter button svg g path circle ellipse rect line polyline polygon text tspan title desc img jv-value jv-field jv-repeat'.split(' '))
const dangerous = new Set('script iframe object embed base meta link form foreignobject animate animatemotion animatetransform set style'.split(' '))
export const boundAttributes = new Set('title aria-label aria-valuenow aria-valuetext x y cx cy x1 x2 y1 y2 width height r rx ry fill stroke opacity'.split(' '))
const attributes = new Set('id class title role type min max step placeholder rows cols maxlength disabled readonly tabindex for value checked max low high optimum width height viewBox preserveAspectRatio d x y cx cy x1 x2 y1 y2 r rx ry points fill stroke stroke-width opacity text-anchor font-size font-family alt bind source as key'.toLowerCase().split(' '))
const valueAttributes = new Set('format labels currency currency-bind date-unit time-zone sync-bind byte-length-bind'.split(' '))
export function parseHtmlTemplate(doc: Document, html: string): { nodes: HtmlTemplateNode[]; warnings: string[] } {
  const template = doc.createElement('template')
  // Template contents are inert; parsed only in the CSP-restricted frame document.
  template.innerHTML = html
  const warnings: string[] = []
  let count = 0
  const visit = (node: Node, depth: number): HtmlTemplateNode[] => {
    if (++count > 5000 || depth > 64) throw new Error('HTML template exceeds 5,000 nodes or 64 nesting levels')
    const id = String(count)
    if (node.nodeType === 3) return [{ text: node.textContent ?? '', attrs: {}, children: [], id }]
    if (node.nodeType !== 1) return []
    const element = node as Element, tag = element.localName.toLowerCase()
    if (dangerous.has(tag)) { warnings.push(`Removed unsafe element: ${tag}`); return [] }
    const children = () => Array.from(node.childNodes).flatMap(child => visit(child, depth + 1))
    if (!tags.has(tag)) { warnings.push(`Unsupported element: ${tag}`); return children() }
    const attrs: Record<string, string> = {}
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase(), value = attr.value
      if ((tag === 'jv-value' || tag === 'jv-field') && valueAttributes.has(name) || tag === 'jv-repeat' && name === 'order') { attrs[name] = value; continue }
      if (name === 'src' && tag === 'img' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 256 * 1024) { attrs.src = value; continue }
      if (name.startsWith('jv-attr-') && boundAttributes.has(name.slice(8)) || name === 'jv-bind' || name === 'jv-value' || attributes.has(name) || /^aria-[a-z-]+$/.test(name)) {
        if ((name === 'fill' || name === 'stroke') && /url\s*\(/i.test(value)) { warnings.push(`Removed URL attribute: ${name}`); continue }
        attrs[name] = value
      } else warnings.push(`Removed unsupported attribute: ${name}`)
    }
    if (tag === 'input' && !['text', 'number', 'range', 'checkbox'].includes(attrs.type ?? 'text')) { warnings.push('Supported inputs: text, number, range, checkbox'); return [] }
    if (/\<jv-(field|value|repeat)\b[^>]*\/\s*>/i.test(html)) throw new Error('Use explicit closing tags for jv-field, jv-value and jv-repeat')
    return [{ tag, attrs, children: children(), id }]
  }
  return { nodes: Array.from(template.content.childNodes).flatMap(node => visit(node, 0)), warnings: [...new Set(warnings)] }
}
