#!/usr/bin/env node
// Publish the public packages at the version stamped into their manifests.
//
// Core publishes before React before CLI, because React pins core at an exact
// version. A package whose version is already on the registry is skipped, so a
// re-run finishes a partial publish. A version that does not order after the
// package's current `latest` is refused, so `latest` never moves back.
//
// Authentication is npm trusted publishing (GitHub OIDC), which needs npm
// 11.5.1 or later; no token is configured.
//
// Usage:
//   node scripts/publish-packages.mjs [--dry-run]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION_PLACEHOLDER } from './version.mjs'

export const PUBLISH_ORDER = ['packages/core', 'packages/react', 'packages/cli']
const REGISTRY = 'https://registry.npmjs.org'
const MINIMUM_NPM = '11.5.1'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new Error(`Unsupported version ${version}`)
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] }
}

/** Whether a release version (`X.Y.Z`) orders after `other`, which may be a prerelease. */
export function ordersAfter(version, other) {
  const candidate = parse(version)
  if (candidate.prerelease) throw new Error(`Release versions carry no prerelease, got ${version}`)
  const existing = parse(other)
  for (let index = 0; index < 3; index += 1) {
    if (candidate.core[index] !== existing.core[index]) return candidate.core[index] > existing.core[index]
  }
  return existing.prerelease !== undefined
}

/** `skip` when the registry already has `version`, `publish` when it may become `latest`. */
export function publishAction({ name, version, published, latest }) {
  if (published.includes(version)) return 'skip'
  if (latest !== undefined && !ordersAfter(version, latest)) {
    throw new Error(`${name}@${version} does not order after latest ${latest}; refusing to move latest back`)
  }
  return 'publish'
}

async function registryState(name) {
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (response.status === 404) return { published: [], latest: undefined }
  if (!response.ok) throw new Error(`${REGISTRY} answered ${response.status} for ${name}`)
  const document = await response.json()
  return { published: Object.keys(document.versions ?? {}), latest: document['dist-tags']?.latest }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run')
  const packages = PUBLISH_ORDER.map((workspace) => ({ workspace, ...JSON.parse(readFileSync(path.join(root, workspace, 'package.json'), 'utf8')) }))
  const versions = new Set(packages.map((manifest) => manifest.version))
  const [version] = versions
  if (versions.size !== 1 || version === VERSION_PLACEHOLDER) {
    throw new Error(`Stamp one release version first (node scripts/version.mjs --stamp); manifests declare ${[...versions].join(', ')}`)
  }
  if (!dryRun) {
    const installed = execFileSync(npm, ['--version'], { encoding: 'utf8' }).trim()
    if (ordersAfter(MINIMUM_NPM, installed)) throw new Error(`Trusted publishing needs npm ${MINIMUM_NPM} or later, found ${installed}`)
  }
  for (const { workspace, name } of packages) {
    const action = publishAction({ name, version, ...await registryState(name) })
    if (action === 'skip') {
      console.log(`${name}@${version} is already published.`)
      continue
    }
    console.log(`Publishing ${name}@${version}${dryRun ? ' (dry run)' : ''}…`)
    execFileSync(npm, ['publish', '--ignore-scripts', ...(dryRun ? ['--dry-run'] : [])], { cwd: path.join(root, workspace), stdio: 'inherit' })
  }
}
