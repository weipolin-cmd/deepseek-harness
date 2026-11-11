/**
 * Assemble the packed release tarballs into one offline-installable bundle.
 *
 * The bundle is a directory holding every packed tarball plus a generated
 * `package.json` that references them as `file:` dependencies, so a plain
 * `npm install` in that directory resolves the whole dsh graph locally instead
 * of asking the registry for versions that may not be published yet.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const version = process.env.BUNDLE_VERSION ?? '0.2.2-rc.2'
const targetOs = process.env.TARGET_OS ?? 'linux'
const targetArch = process.env.TARGET_ARCH ?? 'arm64'
const commit = process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? ''
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : ''

const staging = resolve(root, 'dist/sync')
const bundleName = `dsh-${version}-sync`
const bundleRoot = join(staging, bundleName)
const tarballDir = join(bundleRoot, 'tarballs')

rmSync(staging, { recursive: true, force: true })
mkdirSync(tarballDir, { recursive: true })

const sourceDirs = ['dist/npm', 'dist/npm-vendor', 'dist/npm-landlock']
const tarballs = []
for (const dir of sourceDirs) {
  const absolute = resolve(root, dir)
  if (!existsSync(absolute)) throw new Error(`missing pack output: ${dir}`)
  for (const name of readdirSync(absolute).filter(entry => entry.endsWith('.tgz')).sort()) {
    copyFileSync(join(absolute, name), join(tarballDir, name))
    tarballs.push(name)
  }
}
if (tarballs.length === 0) throw new Error('no tarballs found to bundle')

/** @param {string} tarball */
function readManifest(tarball) {
  return JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
}

/** @param {unknown} value @param {string} actual */
function accepts(value, actual) {
  if (value === undefined) return true
  return Array.isArray(value) ? value.includes(actual) : value === actual
}

const dependencies = {}
const optionalDependencies = {}
const rows = []
for (const name of tarballs) {
  const manifest = readManifest(join(tarballDir, name))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${name} has no name/version in its manifest`)
  }
  const compatible = accepts(manifest.os, targetOs) && accepts(manifest.cpu, targetArch)
  const spec = `file:./tarballs/${name}`
  if (compatible) dependencies[manifest.name] = spec
  else optionalDependencies[manifest.name] = spec
  rows.push({ name: manifest.name, version: manifest.version, compatible })
}

const syncManifest = {
  name: `dsh-sync-${version}`,
  version: '0.0.0',
  private: true,
  description: `Offline install of @deepseek-ai/dsh ${version} (${targetOs}-${targetArch}) built from deepseek-harness ${commit.slice(0, 12)}`,
  engines: { node: '>=24.9.0' },
  dependencies,
  ...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
}
writeFileSync(join(bundleRoot, 'package.json'), `${JSON.stringify(syncManifest, null, 2)}\n`)

const installScript = `#!/usr/bin/env bash
# Install this dsh build into an isolated prefix without touching the registry copy.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
VERSION="\${DSH_SYNC_VERSION:-${version}}"
PREFIX="\${DSH_SYNC_PREFIX:-$HOME/.dsh-sync/$VERSION}"
BIN_DIR="\${DSH_SYNC_BIN_DIR:-$HOME/.local/bin}"

echo "dsh-sync: installing dsh $VERSION into $PREFIX"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
cp -R "$BUNDLE_DIR/tarballs" "$PREFIX/tarballs"
cp "$BUNDLE_DIR/package.json" "$PREFIX/package.json"
(
  cd "$PREFIX"
  npm install --no-audit --no-fund --package-lock=false --loglevel=warn
)

"$PREFIX/node_modules/.bin/dsh" --version || true
mkdir -p "$BIN_DIR"
ln -sfn "$PREFIX/node_modules/.bin/dsh" "$BIN_DIR/dsh"
echo "dsh-sync: linked $BIN_DIR/dsh -> $PREFIX/node_modules/.bin/dsh"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "dsh-sync: add $BIN_DIR to PATH to pick up the new dsh" ;;
esac
`
writeFileSync(join(bundleRoot, 'install.sh'), installScript)
chmodSync(join(bundleRoot, 'install.sh'), 0o755)

const readme = `# dsh ${version} sync bundle (${targetOs}-${targetArch})

Self-contained npm install of \`@deepseek-ai/dsh\` **${version}**, built from
\`deepseek-harness@${commit || '(unknown commit)'}\`${runUrl ? ` ([build run](${runUrl}))` : ''}.

npm may not carry this version yet. This bundle ships every packed
\`@deepseek-ai/*\` tarball for the release, so the harness packages are installed
from local files; ordinary third-party dependencies still come from the npm
registry.

## Install

\`\`\`bash
tar xzf dsh-${version}-sync.tar.gz
cd dsh-${version}-sync
./install.sh
\`\`\`

The installer puts the tree in \`~/.dsh-sync/${version}\` and links
\`~/.local/bin/dsh\` to it. Override the locations with:

- \`DSH_SYNC_PREFIX\` — install prefix
- \`DSH_SYNC_BIN_DIR\` — directory for the \`dsh\` symlink

Your existing global install is left untouched. To switch back, relink
\`~/.local/bin/dsh\` (or remove it) and use the npm-installed binary.

## Layout

- \`tarballs/\` — packed \`@deepseek-ai/*\` packages for this release
- \`package.json\` — every tarball as a \`file:\` dependency
- \`install.sh\` — installer
- \`SHA256SUMS\` — checksums of the tarballs
`
writeFileSync(join(bundleRoot, 'README.md'), readme)

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const sums = tarballs.map(name => `${sha256(join(tarballDir, name))}  tarballs/${name}`)
writeFileSync(join(bundleRoot, 'SHA256SUMS'), `${sums.join('\n')}\n`)

execFileSync('tar', ['-czf', join(staging, `${bundleName}.tar.gz`), '-C', staging, bundleName])

const archive = join(staging, `${bundleName}.tar.gz`)
const archiveSums = [
  `${sha256(archive)}  ${bundleName}.tar.gz`,
  ...tarballs.map(name => `${sha256(join(tarballDir, name))}  tarballs/${name}`),
]
writeFileSync(join(staging, 'SHA256SUMS'), `${archiveSums.join('\n')}\n`)

const meta = {
  version,
  sourceCommit: commit,
  target: { os: targetOs, arch: targetArch },
  builtAt: new Date().toISOString(),
  runUrl,
  tarballCount: tarballs.length,
  externalPackageCount: Object.keys(dependencies).length,
  optionalPackageCount: Object.keys(optionalDependencies).length,
  archive: `${bundleName}.tar.gz`,
  archiveBytes: readFileSync(archive).byteLength,
  packages: rows,
}
writeFileSync(join(staging, 'bundle-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

console.log(`assemble: ${String(rows.length)} tarball(s) -> ${archive}`)
console.log(`assemble: ${String(meta.externalPackageCount)} required, ${String(meta.optionalPackageCount)} optional for ${targetOs}-${targetArch}`)
