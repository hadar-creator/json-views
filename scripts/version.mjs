#!/usr/bin/env node
// The package version, derived from git at publish time.
//
// Nobody edits a version number: every merge to main publishes the packages,
// so the number comes from the commit. The shape is `YYYY.M.<commit count>`,
// e.g. `2026.10.24`: the UTC year and month of the commit's committer date and
// `git rev-list --count` on main, which grows with every merge. The commit
// date, not the build date, keeps the version a function of the commit, so a
// re-run publish derives the same number. npm ignores semver build metadata, so
// the commit is identified by the `gitHead` and provenance npm records instead.
//
// The committed manifests carry the placeholder `0.0.0-managed`, for the
// workspaces and for their dependencies on each other; npm workspaces link the
// placeholder to the local packages. The publish workflow stamps the derived
// version into its own checkout and never into the repository.
//
// Usage:
//   node scripts/version.mjs                       print the derived version
//   node scripts/version.mjs --stamp               stamp it into every workspace manifest and print it
//   node scripts/version.mjs --check-placeholder   fail unless the manifests carry the placeholder
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION_PLACEHOLDER = '0.0.0-managed'
export const WORKSPACES = ['packages/core', 'packages/react', 'packages/cli', 'apps/web']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function formatVersion({ date, count }) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Commit count must be a positive integer, got ${count}`)
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${count}`
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function readGitVersion(cwd = root, ref = 'HEAD') {
  if (git(['rev-parse', '--is-shallow-repository'], cwd) === 'true') {
    throw new Error(`${cwd} is a shallow clone; the commit count needs full history (checkout with fetch-depth: 0)`)
  }
  const count = Number.parseInt(git(['rev-list', '--count', ref], cwd), 10)
  const date = new Date(Number.parseInt(git(['show', '-s', '--format=%ct', ref], cwd), 10) * 1000)
  return formatVersion({ date, count })
}

export function readManifests(directory = root) {
  return ['.', ...WORKSPACES].map((workspace) => {
    const file = path.join(directory, workspace, 'package.json')
    return { file, manifest: JSON.parse(readFileSync(file, 'utf8')) }
  })
}

function internalNames(manifests) {
  return new Set(manifests.map(({ manifest }) => manifest.name))
}

/** The manifest at `version`, with every dependency on another workspace pinned to it. */
export function stampManifest(manifest, version, internal) {
  const stamped = { ...manifest, version }
  for (const field of DEPENDENCY_FIELDS) {
    if (!manifest[field]) continue
    stamped[field] = Object.fromEntries(Object.entries(manifest[field]).map(([name, spec]) => [name, internal.has(name) ? version : spec]))
  }
  return stamped
}

export function placeholderProblems(manifests, directory = root) {
  const internal = internalNames(manifests)
  const problems = []
  for (const { file, manifest } of manifests) {
    const label = path.relative(directory, file)
    if (manifest.version !== VERSION_PLACEHOLDER) problems.push(`${label} declares version ${manifest.version}`)
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (internal.has(name) && spec !== VERSION_PLACEHOLDER) problems.push(`${label} ${field} pins ${name} at ${spec}`)
      }
    }
  }
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--check-placeholder')) {
    const problems = placeholderProblems(readManifests())
    if (problems.length > 0) {
      console.error(`Manifests must carry ${VERSION_PLACEHOLDER}; the publish workflow derives the real version from git:\n${problems.join('\n')}`)
      process.exit(1)
    }
    console.log(`Workspace manifests carry ${VERSION_PLACEHOLDER}.`)
  } else {
    const version = readGitVersion()
    if (args.includes('--stamp')) {
      const manifests = readManifests()
      const internal = internalNames(manifests)
      for (const { file, manifest } of manifests) writeFileSync(file, `${JSON.stringify(stampManifest(manifest, version, internal), null, 2)}\n`)
    }
    console.log(version)
  }
}
