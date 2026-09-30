#!/usr/bin/env node
'use strict'

/**
 * wdk-setup — one-command BareKit + worklet bundle + addon setup for WdkSwiftCore.
 *
 * Usage:
 *   node Scripts/wdk-setup.js [--barekit-tag <tag>] [--barekit-dir <path>] [--force]
 *
 * Run from the directory containing wdk.config.js (the consumer's own project root).
 *
 * What it does, in order — every step here is a direct fix for something that broke
 * during manual spiking against wdk-starter-swift:
 *
 *   1. Ensures @tetherto/wdk-worklet-bundler is installed LOCALLY (never globally).
 *      A global install breaks the bundler's own internal `npx --no-install bare-pack`
 *      call, because bare-pack (a dependency of the bundler) isn't resolvable from the
 *      consumer's cwd when the bundler lives in the global npm tree.
 *
 *   2. Patches the bundler's dynamic-import validator in place. It has a false
 *      positive: it flags any method literally named `import` (e.g. bare-module's own
 *      `ModuleLoader.import(entry, opts) {}`) as if it were a real dynamic import()
 *      expression, aborting bundle generation. The patch excludes matches preceded by
 *      `async ` or followed by `{` (a method-definition shape), while still catching
 *      genuine dynamic imports. Idempotent — safe to run against an already-patched file.
 *
 *   3. Ensures `overrides.bare-lief` is pinned to 0.2.7 in package.json. 0.2.8
 *      non-deterministically corrupts a random subset of addon binaries on repeated
 *      builds (confirmed independently on both iOS, here, and Android, in
 *      wdk-core-kotlin#9 — see holepunchto/bare-lief#14). Without this pin, the same
 *      config can produce a different, seemingly-missing addon on every clean install.
 *
 *   4. Runs `wdk-worklet-bundler generate --install` against wdk.config.js.
 *
 *   5. Links any addons in EXTRA_LINK_MODULES that the bundler's own hardcoded
 *      BARE_LINK_MODULES list doesn't cover yet. Currently just bare-broadcast-channel,
 *      needed by bare-worker. Calls the same `bare-link` package the bundler uses
 *      internally, so the output is identical in shape to what BARE_LINK_MODULES
 *      produces.
 *
 *   6. Fetches BareKit.xcframework, tiered — first that applies wins:
 *        a. --barekit-dir <path>  — pre-provisioned local copy, used as-is, never
 *           modified.
 *        b. Upstream GitHub release — latest, or pinned via --barekit-tag. Same
 *           prebuilds.zip asset wdk-core-kotlin's fetchBareKit uses, extracting
 *           ios/BareKit.xcframework instead of android/. No local-source-build tier —
 *           unlike Android (V8/QuickJS), iOS ships exactly one engine (JSC), so
 *           there's nothing to build from source.
 *
 *   7. Generates a local satellite Swift Package (.wdk-runtime/Package.swift) with one
 *      .binaryTarget per addon xcframework, plus BareKit. This is what a consumer adds
 *      as a local package dependency, once — after that, every build embeds and signs
 *      everything automatically via Xcode's own SwiftPM embed phase.
 *
 *   8. Writes .wdk-runtime/.wdk-setup-marker recording a hash of everything that should
 *      trigger a re-run (wdk.config.js, package.json, the barekit tag/dir). A repeat
 *      invocation with nothing changed is a fast no-op — mirrors wdk-core-kotlin's
 *      .bare-kit-source marker file. Old artifacts are only replaced once the new set
 *      is fully built, so a failed run never leaves the project without working libs.
 *
 * Explicitly NOT handled here — see the issue #5 writeup:
 *   - bare-worker's own bundled bare-module-traverse re-resolving its addon graph
 *     without `linked: true` when a worker thread boots. Confirmed iOS-specific
 *     (Android's full instrumented suite passes clean on the same functionality).
 *     This is a Bare-runtime-level gap, not something this script or wdk.config.js
 *     can work around. Any wallet feature that spins up a worker thread will still
 *     crash regardless of this automation.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const { execFileSync } = require('child_process')

const ROOT = process.cwd()
const RUNTIME_DIR = path.join(ROOT, '.wdk-runtime')
const FRAMEWORKS_DIR = path.join(RUNTIME_DIR, 'Frameworks')
const MARKER_PATH = path.join(RUNTIME_DIR, '.wdk-setup-marker')

// Resolved from the consumer's own wdk.config.js at startup — NOT hardcoded.
// A config can put its addons anywhere (e.g. "./out/ios-addons" instead of
// the "./addons" this script originally assumed); reading it directly from
// the config, the same file the bundler itself reads, is the only way to
// stay correct for every consumer rather than just the one config this was
// first tested against.
let ADDONS_DIR

const EXTRA_LINK_MODULES = ['bare-broadcast-channel']
const HOSTS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']

function log (msg) {
  process.stdout.write(msg + '\n')
}

function fail (msg) {
  process.stderr.write(`\n❌ ${msg}\n`)
  process.exit(1)
}

function parseArgs (argv) {
  const opts = { barekitTag: null, barekitDir: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--barekit-tag') opts.barekitTag = argv[++i]
    else if (argv[i] === '--barekit-dir') opts.barekitDir = argv[++i]
    else if (argv[i] === '--force') opts.force = true
  }
  return opts
}

// ---------------------------------------------------------------------------
// Step 1 — local (never global) bundler install
// ---------------------------------------------------------------------------

function resolveAddonsDir () {
  const configPath = path.join(ROOT, 'wdk.config.js')
  delete require.cache[require.resolve(configPath)] // in case a prior run's require cached a stale version
  const config = require(configPath)

  const configured = config.output?.addons?.ios
  if (!configured) {
    log('⚠ wdk.config.js has no output.addons.ios set — defaulting to ./addons. Set it explicitly to silence this.')
    return path.join(ROOT, 'addons')
  }

  const resolved = path.resolve(ROOT, configured)
  log(`✓ addons output directory from wdk.config.js: ${configured}`)
  return resolved
}

function ensureLocalPackageJson () {
  const pkgPath = path.join(ROOT, 'package.json')
  if (fs.existsSync(pkgPath)) return

  // Without a package.json already in this exact directory, `npm install`
  // walks UP the directory tree looking for one and can silently install
  // relative to an ancestor project instead of here — same visible symptom
  // ("up to date, audited N packages", nothing real created) as an unrelated
  // shell-level npm wrapper silently no-op'ing. Creating one unconditionally,
  // first, removes the ambiguity regardless of which cause is in play.
  log('No package.json here yet — creating one so npm never wanders up to a parent directory.')
  execFileSync('npm', ['init', '-y'], { cwd: ROOT, stdio: 'inherit' })
}

function ensureBundlerInstalledLocally () {
  const bundlerPath = path.join(ROOT, 'node_modules', '@tetherto', 'wdk-worklet-bundler')
  if (fs.existsSync(bundlerPath)) {
    log('✓ @tetherto/wdk-worklet-bundler already installed locally')
    return
  }

  log('Installing @tetherto/wdk-worklet-bundler locally (never globally — see script header)...')
  execFileSync('npm', ['install', '--save-dev', '@tetherto/wdk-worklet-bundler'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
}

// ---------------------------------------------------------------------------
// Step 2 — patch the dynamic-import validator false positive
// ---------------------------------------------------------------------------

function patchDynamicImportValidator () {
  const distDir = path.join(ROOT, 'node_modules', '@tetherto', 'wdk-worklet-bundler', 'dist')
  if (!fs.existsSync(distDir)) fail('wdk-worklet-bundler dist/ not found — did step 1 succeed?')

  const candidates = fs.readdirSync(distDir).filter((f) => f.endsWith('.js'))
  let patched = false

  for (const file of candidates) {
    const fullPath = path.join(distDir, file)
    let content = fs.readFileSync(fullPath, 'utf8')

    // Already patched (idempotent re-run) — our marker comment is present.
    if (content.includes('/* wdk-setup: dynamic-import false-positive patch */')) {
      patched = true
      continue
    }

    const original = 'if (/[^.\\w]import\\s*\\(/.test(content)) problems.push(`${key} still contains a dynamic import()`);'
    if (!content.includes(original)) continue

    const replacement = `/* wdk-setup: dynamic-import false-positive patch */
			{
				const __dynImportRe = /[^.\\w]import\\s*\\(([^)]*)\\)/g;
				let __m, __flagged = false;
				while ((__m = __dynImportRe.exec(content))) {
					const __before = content.slice(Math.max(0, __m.index - 10), __m.index);
					const __after = content.slice(__m.index + __m[0].length, __m.index + __m[0].length + 5);
					if (!/\\basync\\s+$/.test(__before) && !/^\\s*\\{/.test(__after)) { __flagged = true; break; }
				}
				if (__flagged) problems.push(\`\${key} still contains a dynamic import()\`);
			}`

    content = content.replace(original, replacement)
    fs.writeFileSync(fullPath, content)
    patched = true
    log(`✓ patched dynamic-import false positive in dist/${file}`)
  }

  if (!patched) {
    fail(
      'Could not find the dynamic-import validator to patch. The bundler may have ' +
      'changed its compiled output — check dist/*.js for "still contains a dynamic import()" ' +
      'and update this script\'s `original` string to match.'
    )
  }
}

// ---------------------------------------------------------------------------
// Step 3 — pin bare-lief via package.json overrides
// ---------------------------------------------------------------------------

function ensureBareLiefOverride () {
  const pkgPath = path.join(ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) fail('No package.json in the project root — run `npm init -y` first.')

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  pkg.overrides = pkg.overrides || {}

  if (pkg.overrides['bare-lief'] === '0.2.7') {
    log('✓ bare-lief already pinned to 0.2.7 in package.json')
    return false
  }

  pkg.overrides['bare-lief'] = '0.2.7'
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  log('✓ pinned bare-lief to 0.2.7 in package.json (was: ' + (pkg.overrides['bare-lief'] || 'unset') + ')')
  return true
}

function reinstallIfOverrideChanged (overrideChanged, force) {
  if (!overrideChanged && !force) return
  log('Reinstalling node_modules to apply the bare-lief override cleanly...')
  fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true })
  fs.rmSync(path.join(ROOT, 'package-lock.json'), { force: true })
  execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' })

  const liefVersion = readJSON(path.join(ROOT, 'node_modules', 'bare-lief', 'package.json'))?.version
  if (liefVersion !== '0.2.7') {
    fail(`bare-lief resolved to ${liefVersion} after reinstall, expected 0.2.7 — check for a conflicting override elsewhere.`)
  }
  log('✓ confirmed bare-lief 0.2.7 resolved after reinstall')
}

// ---------------------------------------------------------------------------
// Step 4 — generate the bundle + standard addons
// ---------------------------------------------------------------------------

function runBundlerGenerate () {
  log('\nRunning wdk-worklet-bundler generate --install...\n')
  execFileSync('npx', ['wdk-worklet-bundler', 'generate', '--install'], {
    cwd: ROOT,
    stdio: 'inherit'
  })

  if (!fs.existsSync(ADDONS_DIR)) {
    fail('Bundle generation did not produce an addons/ directory — check the output above.')
  }
}

// ---------------------------------------------------------------------------
// Step 5 — link addons the bundler's hardcoded list doesn't cover
// ---------------------------------------------------------------------------

async function linkExtraModules () {
  let link
  try {
    link = require(path.join(ROOT, 'node_modules', 'bare-link'))
  } catch {
    fail('Could not resolve bare-link from node_modules — is @tetherto/wdk-worklet-bundler installed?')
  }

  for (const moduleName of EXTRA_LINK_MODULES) {
    const already = fs.existsSync(ADDONS_DIR) &&
      fs.readdirSync(ADDONS_DIR).some((f) => f.startsWith(moduleName + '.'))
    if (already) {
      log(`✓ ${moduleName} already present in addons/ (bundler covered it this time)`)
      continue
    }

    const modulePath = path.join(ROOT, 'node_modules', moduleName)
    if (!fs.existsSync(modulePath)) {
      fail(`${moduleName} not found in node_modules — is it a real (possibly transitive) dependency of this project?`)
    }

    log(`Linking ${moduleName} (not in wdk-worklet-bundler's built-in addon list)...`)
    for await (const _step of link(modulePath, { hosts: HOSTS, out: ADDONS_DIR })) {
      // bare-link logs its own progress; nothing to do per-step here.
    }
    log(`✓ linked ${moduleName}`)
  }
}

// ---------------------------------------------------------------------------
// Step 6 — fetch BareKit, tiered
// ---------------------------------------------------------------------------

function fetchJSON (url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wdk-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJSON(res.headers.location))
      }
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function downloadFile (url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wdk-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, destPath))
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', reject)
  })
}

async function fetchBareKit (opts) {
  const destXcframework = path.join(FRAMEWORKS_DIR, 'BareKit.xcframework')

  if (opts.barekitDir) {
    log(`Using pre-provisioned BareKit at ${opts.barekitDir} (never modified)`)
    fs.rmSync(destXcframework, { recursive: true, force: true })
    fs.cpSync(path.join(opts.barekitDir, 'BareKit.xcframework'), destXcframework, { recursive: true })
    return
  }

  const tagPath = opts.barekitTag ? `tags/${opts.barekitTag}` : 'latest'
  log(`Resolving bare-kit release (${opts.barekitTag || 'latest'})...`)
  const release = await fetchJSON(`https://api.github.com/repos/holepunchto/bare-kit/releases/${tagPath}`)

  const asset = (release.assets || []).find((a) => a.name === 'prebuilds.zip')
  if (!asset) fail(`No prebuilds.zip asset found on bare-kit release ${release.tag_name || opts.barekitTag}`)

  const tmpZip = path.join(RUNTIME_DIR, '.barekit-prebuilds.zip')
  log(`Downloading ${asset.browser_download_url} (${Math.round(asset.size / 1024 / 1024)} MB)...`)
  await downloadFile(asset.browser_download_url, tmpZip)

  const tmpExtract = path.join(RUNTIME_DIR, '.barekit-extracted')
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  execFileSync('unzip', ['-q', tmpZip, 'ios/*', '-d', tmpExtract])

  fs.rmSync(destXcframework, { recursive: true, force: true })
  fs.cpSync(path.join(tmpExtract, 'ios', 'BareKit.xcframework'), destXcframework, { recursive: true })

  fs.rmSync(tmpZip, { force: true })
  fs.rmSync(tmpExtract, { recursive: true, force: true })

  log(`✓ BareKit ${release.tag_name || opts.barekitTag} staged`)
}

// ---------------------------------------------------------------------------
// Step 7 — generate the satellite Swift Package
// ---------------------------------------------------------------------------

function sanitizeTargetName (xcframeworkName) {
  return xcframeworkName
    .replace(/\.xcframework$/, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/^([0-9])/, '_$1')
}

function generateSatellitePackage () {
  fs.mkdirSync(FRAMEWORKS_DIR, { recursive: true })

  const addonFiles = fs.readdirSync(ADDONS_DIR).filter((f) => f.endsWith('.xcframework'))
  if (addonFiles.length === 0) fail('No addon xcframeworks found in addons/ — nothing to package.')

  // Refresh the ADDON entries in Frameworks/ from scratch, so a stale prior
  // run's addon can never linger alongside this one (the exact "old file
  // survives, count mismatches" class of bug from earlier debugging).
  // BareKit.xcframework is deliberately left alone here — fetchBareKit()
  // already staged it before this function runs, and wiping the whole
  // directory would delete it out from under the check just below.
  for (const entry of fs.readdirSync(FRAMEWORKS_DIR)) {
    if (entry === 'BareKit.xcframework') continue
    fs.rmSync(path.join(FRAMEWORKS_DIR, entry), { recursive: true, force: true })
  }

  const seen = new Set()
  const targets = []
  const productTargets = []

  for (const entry of addonFiles) {
    const name = sanitizeTargetName(entry)
    if (seen.has(name)) fail(`Name collision after sanitizing "${entry}" -> "${name}"`)
    seen.add(name)

    fs.cpSync(path.join(ADDONS_DIR, entry), path.join(FRAMEWORKS_DIR, entry), { recursive: true })
    targets.push(`        .binaryTarget(name: "${name}", path: "Frameworks/${entry}")`)
    productTargets.push(`"${name}"`)
  }

  const bareKitSrc = path.join(FRAMEWORKS_DIR, 'BareKit.xcframework')
  if (!fs.existsSync(bareKitSrc)) fail('BareKit.xcframework missing from Frameworks/ — did fetchBareKit run first?')
  targets.push('        .binaryTarget(name: "BareKitBinary", path: "Frameworks/BareKit.xcframework")')
  productTargets.push('"BareKitBinary"')

  const manifest = `// swift-tools-version: 5.9
// Generated by wdk-setup. Do not edit by hand — re-run \`swift package wdk-setup\`
// (or \`node Scripts/wdk-setup.js\`) after changing wdk.config.js instead.
import PackageDescription

let package = Package(
    name: "WdkRuntime",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "WdkRuntime", targets: [${productTargets.join(', ')}])
    ],
    targets: [
${targets.join(',\n')}
    ]
)
`

  fs.writeFileSync(path.join(RUNTIME_DIR, 'Package.swift'), manifest)
  log(`✓ .wdk-runtime/Package.swift written — ${addonFiles.length} addons + BareKit`)
}

// ---------------------------------------------------------------------------
// Step 8 — idempotency marker
// ---------------------------------------------------------------------------

function readJSON (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function computeInputHash (opts) {
  const hash = crypto.createHash('sha256')
  const configPath = path.join(ROOT, 'wdk.config.js')
  if (fs.existsSync(configPath)) hash.update(fs.readFileSync(configPath))
  const pkgPath = path.join(ROOT, 'package.json')
  if (fs.existsSync(pkgPath)) hash.update(fs.readFileSync(pkgPath))
  hash.update(JSON.stringify({ tag: opts.barekitTag, dir: opts.barekitDir }))
  return hash.digest('hex')
}

function readMarker () {
  return readJSON(MARKER_PATH)
}

function writeMarker (inputHash) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  fs.writeFileSync(MARKER_PATH, JSON.stringify({
    inputHash,
    generatedAt: new Date().toISOString()
  }, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  const opts = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(path.join(ROOT, 'wdk.config.js'))) {
    fail('No wdk.config.js in the current directory. Run this from your project root, next to wdk.config.js.')
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  ADDONS_DIR = resolveAddonsDir()
  const inputHash = computeInputHash(opts)
  const marker = readMarker()
  if (!opts.force && marker && marker.inputHash === inputHash && fs.existsSync(path.join(RUNTIME_DIR, 'Package.swift'))) {
    log(`✓ Nothing changed since the last run (${marker.generatedAt}) — skipping. Use --force to regenerate anyway.`)
    return
  }

  log('=== wdk-setup ===\n')

  ensureLocalPackageJson()
  ensureBundlerInstalledLocally()
  const overrideChanged = ensureBareLiefOverride()
  reinstallIfOverrideChanged(overrideChanged, opts.force)
  // Patched AFTER any reinstall, never before — a bare-lief override change
  // wipes node_modules and reinstalls fresh, which would silently undo an
  // earlier patch and reintroduce the exact failure it fixes.
  patchDynamicImportValidator()

  runBundlerGenerate()
  await linkExtraModules()
  await fetchBareKit(opts)
  generateSatellitePackage()
  writeMarker(inputHash)

  log('\n✅ wdk-setup complete.')
  log('   Add .wdk-runtime as a local Swift package dependency (once), then build as usual.')
  log('   Known limitation: any feature that spins up a worker thread (bare-worker) will')
  log('   still crash — that gap is upstream in Bare\'s runtime, not fixed by this script.')
}

main().catch((err) => {
  fail(err.stack || String(err))
})