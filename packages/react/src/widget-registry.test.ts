import { expect, it } from 'vitest'

import { createDefaultWidgetRegistry } from './widget-registry.js'

const CustomEditor = () => null

it('keeps Enter for line breaks in long-form editors unless a registration says otherwise', () => {
  const widgets = createDefaultWidgetRegistry()
  expect(['markdown', 'body', 'html'].map((type) => widgets.getDefinition(type)?.enterKey)).toEqual(['newline', 'newline', 'newline'])
  expect(widgets.getDefinition('text')?.enterKey).toBeUndefined()

  widgets.register('markdown', CustomEditor)
  expect(widgets.getDefinition('markdown')).toMatchObject({ editor: CustomEditor, enterKey: 'newline' })
  widgets.register('markdown', { editor: CustomEditor, enterKey: 'submit' })
  expect(widgets.getDefinition('markdown')?.enterKey).toBe('submit')
})
