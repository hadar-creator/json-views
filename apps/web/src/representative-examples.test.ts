import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileJsonViewMetadata, createDefaultTypeRegistry, validateCsvSource } from '@script-it/json-views-core'

interface ManifestEntry {
  id: string
  sourceFile: string
  annotationFile?: string
  relativePath?: string
  sourceSha256: string
  bytes: number
}

const examplesDirectory = join(process.cwd(), 'public', 'representative-examples')
const manifest = JSON.parse(readFileSync(join(examplesDirectory, 'manifest.json'), 'utf8')) as ManifestEntry[]
const exampleIds = [
  'task-management',
  'llm-messages',
  'research-sprint',
  'decision-comparison',
] as const

describe('bundled examples', () => {
  it('opens the guide with a welcome page and article database and preserves plain example formats', () => {
    const guide = JSON.parse(readFileSync(join(examplesDirectory, manifest[0].sourceFile), 'utf8'))
    const compiled = compileJsonViewMetadata(guide)
    expect(compiled.diagnostics).toEqual([])
    expect(compiled.views).toHaveLength(2)
    expect(compiled.views[0].display).toBe('adaptive')
    expect(compiled.views[1].value).toEqual(guide.articles)
    expect(guide.articles).toHaveLength(7)
    for (const entry of manifest) {
      const source = readFileSync(join(examplesDirectory, entry.sourceFile), 'utf8')
      expect(Buffer.byteLength(source)).toBe(entry.bytes)
      expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sourceSha256)
      if (entry.sourceFile.endsWith('.csv')) {
        expect(() => validateCsvSource(source)).not.toThrow()
      } else if (!entry.annotationFile) {
        expect(compileJsonViewMetadata(JSON.parse(source)).diagnostics).toEqual([])
      }
      if (entry.id !== 'json-views') expect(entry.relativePath).toMatch(/^(Templates|Examples)\//)
    }
    const array = manifest.find((entry) => entry.id === 'array-root')!
    expect(Array.isArray(JSON.parse(readFileSync(join(examplesDirectory, array.sourceFile), 'utf8')))).toBe(true)
  })

  it.each(exampleIds)('ships a valid, integrity-checked %s document', (id) => {
    const entry = manifest.find((candidate) => candidate.id === id)
    expect(entry).toBeDefined()

    const sourceText = readFileSync(join(examplesDirectory, entry!.sourceFile), 'utf8')
    const metadata = JSON.parse(readFileSync(join(examplesDirectory, entry!.annotationFile!), 'utf8')) as Record<string, unknown>
    const source = JSON.parse(sourceText) as unknown
    const compiled = compileJsonViewMetadata(source, createDefaultTypeRegistry(), { metadata })

    expect(Buffer.byteLength(sourceText)).toBe(entry!.bytes)
    expect(createHash('sha256').update(sourceText).digest('hex')).toBe(entry!.sourceSha256)
    expect(compiled.status).toBe('ready')
    expect(compiled.diagnostics).toEqual([])
    expect(compiled.views.length).toBeGreaterThanOrEqual(3)
  })

  it('demonstrates nested LLM attachment and tool-call collections', () => {
    const entry = manifest.find((candidate) => candidate.id === 'llm-messages')!
    const source = JSON.parse(readFileSync(join(examplesDirectory, entry.sourceFile), 'utf8')) as {
      messages: Array<{ attachments?: unknown[]; tool_calls?: unknown[] }>
    }
    const metadata = JSON.parse(readFileSync(join(examplesDirectory, entry.annotationFile!), 'utf8')) as Record<string, unknown>
    const compiled = compileJsonViewMetadata(source, createDefaultTypeRegistry(), { metadata })

    expect(source.messages[1]?.attachments).toHaveLength(2)
    expect(source.messages[2]?.tool_calls).toHaveLength(2)
    expect(compiled.views.map((view) => view.id)).toEqual(expect.arrayContaining(['attachments', 'tool-calls']))
  })
})
