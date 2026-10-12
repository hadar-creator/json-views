import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ordersAfter, publishAction } from './publish-packages.mjs'
import { VERSION_PLACEHOLDER, formatVersion, placeholderProblems, readGitVersion, stampManifest } from './version.mjs'

test('versions are the UTC year and month of the commit and the commit count', () => {
  assert.equal(formatVersion({ date: new Date('2026-10-12T09:00:00Z'), count: 24 }), '2026.10.24')
  assert.equal(formatVersion({ date: new Date('2027-01-03T00:00:00Z'), count: 130 }), '2027.1.130')
  assert.equal(formatVersion({ date: new Date('2026-10-31T23:30:00-03:00'), count: 24 }), '2026.11.24')
  assert.throws(() => formatVersion({ date: new Date(), count: 0 }), /positive integer/)
})

test('the version derives from the history, not the clock, and never moves back', () => {
  const repository = mkdtempSync(path.join(tmpdir(), 'json-views-version-'))
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const commit = (message, date) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message], {
      cwd: repository,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
    execFileSync('git', ['init', '-q'], { cwd: repository, env })
    commit('first', '2026-09-30T23:00:00-02:00')
    commit('second', '2026-09-30T23:00:00-02:00')
    assert.equal(readGitVersion(repository), '2026.10.2')
    assert.equal(readGitVersion(repository, 'HEAD~1'), '2026.10.1')
    commit('backdated', '2026-08-15T12:00:00Z')
    assert.equal(readGitVersion(repository), '2026.10.3')
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
})

test('stamping pins internal dependencies to the version and leaves the rest', () => {
  const manifest = {
    name: '@script-it/json-views-react',
    version: VERSION_PLACEHOLDER,
    dependencies: { '@script-it/json-views-core': VERSION_PLACEHOLDER, clsx: '^2.1.1' },
    peerDependencies: { react: '^18.0.0 || ^19.0.0' },
  }
  const stamped = stampManifest(manifest, '2026.10.24', new Set(['@script-it/json-views-core', '@script-it/json-views-react']))
  assert.deepEqual(stamped, {
    name: '@script-it/json-views-react',
    version: '2026.10.24',
    dependencies: { '@script-it/json-views-core': '2026.10.24', clsx: '^2.1.1' },
    peerDependencies: { react: '^18.0.0 || ^19.0.0' },
  })
  assert.equal(manifest.version, VERSION_PLACEHOLDER)
})

test('placeholder check names stray versions and internal pins', () => {
  const manifests = [
    { file: '/repo/packages/core/package.json', manifest: { name: 'core', version: '2026.10.24' } },
    { file: '/repo/packages/react/package.json', manifest: { name: 'react', version: VERSION_PLACEHOLDER, dependencies: { core: '2026.10.24', clsx: '^2.1.1' } } },
  ]
  assert.deepEqual(placeholderProblems(manifests, '/repo'), [
    'packages/core/package.json declares version 2026.10.24',
    'packages/react/package.json dependencies pins core at 2026.10.24',
  ])
})

test('release versions order after the beta and after earlier releases', () => {
  assert.equal(ordersAfter('2026.10.24', '0.1.0-beta.1'), true)
  assert.equal(ordersAfter('2026.11.25', '2026.10.24'), true)
  assert.equal(ordersAfter('2026.10.24', '2026.10.24-rc.1'), true)
  assert.equal(ordersAfter('2026.10.24', '2026.10.24'), false)
  assert.equal(ordersAfter('2026.10.9', '2026.10.24'), false)
  assert.equal(ordersAfter('2026.9.30', '2026.10.24'), false)
  assert.throws(() => ordersAfter('2026.10.24-rc.1', '2026.10.23'), /no prerelease/)
})

test('publishing skips a published version and never moves latest back', () => {
  const name = '@script-it/json-views-core'
  assert.equal(publishAction({ name, version: '2026.10.24', published: [], latest: undefined }), 'publish')
  assert.equal(publishAction({ name, version: '2026.10.24', published: ['0.1.0-beta.1'], latest: '0.1.0-beta.1' }), 'publish')
  assert.equal(publishAction({ name, version: '2026.10.24', published: ['2026.10.24'], latest: '2026.10.24' }), 'skip')
  assert.throws(() => publishAction({ name, version: '2026.10.20', published: ['2026.10.24'], latest: '2026.10.24' }), /refusing to move latest back/)
})
