#!/usr/bin/env node
'use strict'

/**
 * wdk-setup — one-command BareKit + worklet bundle + addon setup for WdkSwiftCore.
 *
 * Usage:
 *   node Scripts/wdk-setup.js [--platform ios|macos] [--engine jsc|v8]
 *                             [--barekit-tag <tag>] [--barekit-dir <path>]
 *                             [--bundler-ref <npm-or-git-ref>] [--pin <name@version>]...
 *                             [--force]
 *
 * --platform (default: ios) — ios produces the .wdk-runtime satellite Swift
 *   Package (a small local package of binary targets) that a consumer app adds
 *   as a local dependency. macos produces test resources for wdk-core-swift's
 *   OWN Tests/WdkSwiftCoreTests suite instead — run it from wdk-core-swift's
 *   own repo root, not a consumer app. There is no satellite package on macOS;
 *   it stages Tests/Resources/macos (addon frameworks + worklet bundle) and
 *   Frameworks/BareKit.xcframework, then runs Scripts/prepare-macos-frameworks.sh.
 *
 * --engine (default: jsc) — BareKit's prebuilds.zip ships two complete engine
 *   builds side by side (ios/ + darwin/ for V8, ios-javascriptcore/ +
 *   darwin-javascriptcore/ for JavaScriptCore) — not one build with an option.
 *   JSC is the default because it is the engine Apple ships and is ~11x smaller.
 *   V8 is the only one that works with worker threads today, so pass
 *   --engine v8 until holepunchto/bare-node-runtime#13 and holepunchto/libjsc#26
 *   are fixed. V8 loads ES modules natively (convertEsmToCjs: false); JSC
 *   needs convertEsmToCjs: true.
 *
 * --bundler-ref — install @tetherto/wdk-worklet-bundler from this npm version or
 *   git ref instead of the default (exactly 1.0.0-beta.15; see
 *   DEFAULT_BUNDLER_VERSION below), e.g. to try an unreleased build. Pin a full
 *   commit SHA: a branch or PR head can change under you.
 *
 * --pin name@version (repeatable) — extra exact dependency pins, written as
 *   direct dependencies like the bare-node-runtime pin below.
 *
 * Run from the directory containing wdk.config.js (the consumer's own project
 * root for --platform ios; wdk-core-swift's own repo root for --platform macos).
 *
 * What it does, in order — each step addresses a concrete problem found while
 * setting this up by hand:
 *
 *   1. Writes a fresh package.json and installs the JS tooling LOCALLY (never
 *      globally), wiping node_modules and the lockfile first. A global bundler
 *      install breaks the bundler's own `npx --no-install bare-pack` call, because
 *      bare-pack isn't resolvable from the consumer's cwd. package.json,
 *      package-lock.json and node_modules are generated output: don't commit or
 *      hand-edit them.
 *
 *      bare-node-runtime is pinned to 1.5.0 as a DIRECT dependency (not an npm
 *      `overrides` entry — the bundler's own install step adds an unversioned
 *      bare-node-runtime, which npm rejects as a conflict with an override).
 *      1.5.1+ unconditionally requires bare-worker/global on every app's boot
 *      path, and JavaScriptCore's port is missing the SharedArrayBuffer binding
 *      bare-worker needs — see holepunchto/bare-node-runtime#13 and
 *      holepunchto/libjsc#26. Remove the pin once those are fixed.
 *
 *   2. Patches the bundler's dynamic-import validator in place (after step 1,
 *      since an install would undo it). It has a false positive: it flags any
 *      method literally named `import` (e.g. bare-module's own
 *      `ModuleLoader.import(entry, opts) {}`) as if it were a real dynamic import()
 *      expression, aborting bundle generation. The patch excludes matches preceded
 *      by `async ` or followed by `{` (a method-definition shape), while still
 *      catching genuine dynamic imports. Idempotent.
 *
 *   3. Runs `wdk-worklet-bundler generate --install` against wdk.config.js.
 *      Platforms come from options.targets (ios-* / darwin-* / android-*) or,
 *      for older bundlers, options.platforms; the addon output directory comes
 *      from output.addons.<platform>.
 *
 *   4. Links any addons in EXTRA_LINK_MODULES that the bundler didn't link itself.
 *      Currently just bare-broadcast-channel (needed by bare-worker). Uses the same
 *      `bare-link` the bundler uses. Bundlers before 1.0.0-beta.15 link a fixed
 *      addon list and miss it; 1.0.0-beta.15 and later discover addons from the
 *      bundle itself, so here this step is redundant but harmless.
 *
 *   5. Fetches BareKit.xcframework, tiered — first that applies wins:
 *        a. --barekit-dir <path>  — pre-provisioned local copy, used as-is, never
 *           modified.
 *        b. Upstream GitHub release — latest, or pinned via --barekit-tag. The
 *           same prebuilds.zip asset wdk-core-kotlin's fetchBareKit uses; the
 *           folder taken from it depends on --platform and --engine (see above).
 *
 *   6. iOS: generates the local satellite Swift Package (.wdk-runtime/Package.swift)
 *      with one .binaryTarget per addon xcframework, plus BareKit. A consumer adds
 *      it as a local package dependency once; after that every build embeds and
 *      signs everything via Xcode's own SwiftPM embed phase.
 *      macOS: stages the test resources and runs prepare-macos-frameworks.sh.
 *
 *   7. Writes .wdk-runtime/.wdk-setup-marker, a hash of everything that should
 *      trigger a re-run (wdk.config.js, --platform, --engine, --barekit-tag/dir,
 *      --bundler-ref, --pin). A repeat invocation with nothing changed, and the
 *      output still on disk, is a fast no-op (--force overrides). Mirrors
 *      wdk-core-kotlin's .bare-kit-source marker file.
 *
 * Known limitation: on the JavaScriptCore engine, code that starts a worker
 * thread (bare-worker) does not work yet — JSC's port lacks the SharedArrayBuffer
 * binding it needs (holepunchto/libjsc#26). Neither this script nor wdk.config.js
 * can work around that; use --engine v8 until it is fixed upstream.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const { execFileSync } = require('child_process')

const ROOT = process.cwd()
const RUNTIME_DIR = path.join(ROOT, '.wdk-runtime')
const MARKER_PATH = path.join(RUNTIME_DIR, '.wdk-setup-marker')

// Both set in main(), once --platform is known:
//   ios   -> FRAMEWORKS_DIR = .wdk-runtime/Frameworks (feeds the satellite package)
//   macos -> FRAMEWORKS_DIR = Frameworks (repo root — matches
//            Scripts/prepare-macos-frameworks.sh's own hardcoded expectation)
let FRAMEWORKS_DIR

// Resolved from the consumer's own wdk.config.js at startup — NOT hardcoded.
// A config can put its addons anywhere (e.g. "./out/ios-addons" instead of
// the "./addons" this script originally assumed); reading it directly from
// the config, the same file the bundler itself reads, is the only way to
// stay correct for every consumer rather than just the one config this was
// first tested against.
let ADDONS_DIR

const EXTRA_LINK_MODULES = ['bare-broadcast-channel']
const IOS_HOSTS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
const MACOS_HOSTS = ['darwin-arm64', 'darwin-x64']

// The worklet bundler version installed when --bundler-ref isn't given. EXACT on
// purpose, not a range: a floating ^1.0.0-beta.14 silently picked up beta.15
// (published 2026-10-09), which rejects options.platforms and links a different
// set of addons, and every existing config stopped working. Bump it deliberately,
// together with the docs and a test run.
const DEFAULT_BUNDLER_VERSION = '1.0.0-beta.15'

function log (msg) {
  process.stdout.write(msg + '\n')
}

function fail (msg) {
  process.stderr.write(`\n❌ ${msg}\n`)
  process.exit(1)
}

function parseArgs (argv) {
  const opts = {
    barekitTag: null,
    barekitDir: null,
    force: false,
    bundlerRef: null,
    platform: 'ios',
    engine: 'jsc',
    extraPins: {}
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--barekit-tag') opts.barekitTag = argv[++i]
    else if (argv[i] === '--barekit-dir') opts.barekitDir = argv[++i]
    else if (argv[i] === '--force') opts.force = true
    else if (argv[i] === '--bundler-ref') opts.bundlerRef = argv[++i]
    else if (argv[i] === '--platform') opts.platform = argv[++i]
    else if (argv[i] === '--engine') opts.engine = argv[++i]
    else if (argv[i] === '--pin') {
      const [name, version] = argv[++i].split('@')
      if (!name || !version) fail(`--pin expects "<name>@<version>", got "${argv[i]}"`)
      opts.extraPins[name] = version
    }
  }
  if (!['ios', 'macos'].includes(opts.platform)) {
    fail(`Unknown --platform "${opts.platform}" — expected "ios" or "macos".`)
  }
  if (!['jsc', 'v8'].includes(opts.engine)) {
    fail(`Unknown --engine "${opts.engine}" — expected "jsc" or "v8".`)
  }
  return opts
}

// ---------------------------------------------------------------------------
// Step 1 — local (never global) bundler install
// ---------------------------------------------------------------------------

// Which platforms a wdk.config.js asks the bundler to build addons for.
//
// Two bundler generations, two shapes:
//   older (1.0.0-beta.14 and earlier): options.platforms: ["ios"]
//   newer (1.0.0-beta.15 and later): options.platforms is REJECTED outright
//     ("this option was removed"); platforms are derived from options.targets
//     (ios-* -> ios, darwin-* -> macos, android-* -> android).
// Reading both lets this script work with either, instead of demanding a key
// the newer bundler refuses. Note the newer bundler defaults targets to all
// iOS + Android hosts when omitted, so a config with neither key is almost
// certainly a mistake here and is rejected below.
const TARGET_PREFIX_TO_PLATFORM = { ios: 'ios', darwin: 'macos', android: 'android' }

function configuredPlatformsOf (config) {
  const found = new Set(config.options?.platforms || [])
  for (const target of config.options?.targets || []) {
    const platform = TARGET_PREFIX_TO_PLATFORM[String(target).split('-')[0]]
    if (platform) found.add(platform)
  }
  return [...found]
}

function resolveAddonsDir (platform) {
  const configPath = path.join(ROOT, 'wdk.config.js')
  delete require.cache[require.resolve(configPath)] // in case a prior run's require cached a stale version
  const config = require(configPath)

  const configuredPlatforms = configuredPlatformsOf(config)
  if (!configuredPlatforms.includes(platform)) {
    const wantedPrefix = platform === 'macos' ? 'darwin-*' : `${platform}-*`
    fail(
      `wdk.config.js builds addons for [${configuredPlatforms.join(', ') || 'nothing set'}] but ` +
      `--platform ${platform} was requested. Add ${wantedPrefix} hosts to options.targets ` +
      `(e.g. ${platform === 'macos' ? '"darwin-arm64", "darwin-x64"' : '"ios-arm64", "ios-arm64-simulator", "ios-x64-simulator"'}).`
    )
  }

  const configured = config.output?.addons?.[platform]
  const fallback = platform === 'macos' ? 'mac-addons' : 'addons'
  if (!configured) {
    log(`⚠ wdk.config.js has no output.addons.${platform} set — defaulting to ./${fallback}. Set it explicitly to silence this.`)
    return path.join(ROOT, fallback)
  }

  const resolved = path.resolve(ROOT, configured)
  log(`✓ addons output directory from wdk.config.js: ${configured}`)
  return resolved
}

// package.json, package-lock.json, and node_modules are PURE GENERATED OUTPUT
// here, not consumer-owned source — nothing in this project needs them to
// be anything other than build-time JS tooling for running the bundler.
// This function rewrites package.json fresh on every run and reinstalls from
// scratch, so there's nothing to commit and nothing that can drift out of
// sync with what this script actually needs. If you've hand-edited
// package.json for some other reason, that edit will be overwritten the next
// time this runs — don't hand-edit it; add to this function instead.
//
// bundlerRef lets a specific npm version or git ref (e.g. an unreleased bundler
// branch) be used instead of DEFAULT_BUNDLER_VERSION — e.g.
// `--bundler-ref github:tetherto/wdk-worklet-bundler#<commit>`. Pin a full commit
// SHA for anything you want to reproduce.
function writePackageJsonAndInstall (bundlerRef, extraPins) {
  const pkgPath = path.join(ROOT, 'package.json')

  // A PR/branch ref moves whenever its author pushes — PR#65's head changed
  // its config schema between two of our own test runs. Fine for a quick look,
  // wrong for anything you want to reproduce: pin a commit SHA instead.
  if (bundlerRef && /#(pull\/\d+\/(head|merge)|[A-Za-z][\w./-]*)$/.test(bundlerRef) && !/#[0-9a-f]{40}$/.test(bundlerRef)) {
    log(`⚠ --bundler-ref "${bundlerRef}" is a moving reference (branch or PR head) — results can change under you. Pin a full commit SHA to reproduce a run.`)
  }

  const pkg = {
    name: path.basename(ROOT),
    private: true,
    dependencies: {
      // Temporary, pinned as a DIRECT dependency rather than an `overrides`
      // entry — bare-node-runtime >= 1.5.1 unconditionally requires
      // bare-worker/global on every app's boot path, and JavaScriptCore's
      // port doesn't implement the SharedArrayBuffer binding bare-worker
      // needs at load time. Tracked at
      // https://github.com/holepunchto/bare-node-runtime/issues/13 — remove
      // this pin once that lands.
      //
      // Must be a direct dependency, not `overrides`: the bundler's own
      // "install missing core dependencies" step runs a plain unversioned
      // `npm install bare-node-runtime` when it isn't already present, which
      // writes its own direct-dependency entry — that collides with an
      // `overrides` entry (npm refuses with EOVERRIDE) almost every time.
      // Declaring it ourselves first means the bundler finds it already
      // installed and never tries to add its own entry at all.
      'bare-node-runtime': '1.5.0',
      // Any additional exact pins passed via repeatable `--pin name@version`
      // flags — e.g. the full "era pin" set a specific BareKit tag /
      // convertEsmToCjs combination needs, which isn't baked into this
      // script since it's tied to one specific validated test config, not
      // something every consumer needs. Same direct-dependency reasoning as
      // bare-node-runtime applies to each of these too.
      ...(extraPins || {})
    },
    devDependencies: {
      '@tetherto/wdk-worklet-bundler': bundlerRef || DEFAULT_BUNDLER_VERSION
    }
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  log('✓ wrote package.json (generated — not meant to be committed or hand-edited)')

  fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true })
  fs.rmSync(path.join(ROOT, 'package-lock.json'), { force: true })

  log('Installing JS tooling (bundler + pinned overrides)...')
  execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' })

  for (const [name, expectedVersion] of Object.entries(pkg.dependencies)) {
    const actual = readJSON(path.join(ROOT, 'node_modules', name, 'package.json'))?.version
    if (actual !== expectedVersion) {
      fail(`${name} resolved to ${actual}, expected ${expectedVersion} — check for a conflicting dependency elsewhere.`)
    }
    log(`✓ confirmed ${name} ${expectedVersion} resolved`)
  }
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

async function linkExtraModules (platform) {
  let link
  try {
    link = require(path.join(ROOT, 'node_modules', 'bare-link'))
  } catch {
    fail('Could not resolve bare-link from node_modules — is @tetherto/wdk-worklet-bundler installed?')
  }

  const hosts = platform === 'macos' ? MACOS_HOSTS : IOS_HOSTS

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
    for await (const _step of link(modulePath, { hosts, out: ADDONS_DIR })) {
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

// prebuilds.zip ships SIX top-level folders, two complete engine builds side
// by side — not one build with an engine option:
//   ios/  darwin/  apple/                               (V8)
//   ios-javascriptcore/  darwin-javascriptcore/  apple-javascriptcore/   (JSC)
// "apple" is a combined iOS+macOS universal xcframework (unused here); "ios"
// and "darwin" are single-platform builds. Verified directly against a real
// release — ios/ and ios-javascriptcore/ each contain only iOS device+sim
// slices; darwin/ and darwin-javascriptcore/ each contain only one
// macos-arm64_x86_64 slice.
function bareKitZipFolder (platform, engine) {
  const platformKey = platform === 'macos' ? 'darwin' : 'ios'
  return engine === 'v8' ? platformKey : `${platformKey}-javascriptcore`
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

  const zipFolder = bareKitZipFolder(opts.platform, opts.engine)
  const tmpZip = path.join(RUNTIME_DIR, '.barekit-prebuilds.zip')
  log(`Downloading ${asset.browser_download_url} (${Math.round(asset.size / 1024 / 1024)} MB)...`)
  await downloadFile(asset.browser_download_url, tmpZip)

  const tmpExtract = path.join(RUNTIME_DIR, '.barekit-extracted')
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  execFileSync('unzip', ['-q', tmpZip, `${zipFolder}/*`, '-d', tmpExtract])

  fs.rmSync(destXcframework, { recursive: true, force: true })
  fs.cpSync(path.join(tmpExtract, zipFolder, 'BareKit.xcframework'), destXcframework, { recursive: true })

  fs.rmSync(tmpZip, { force: true })
  fs.rmSync(tmpExtract, { recursive: true, force: true })

  log(`✓ BareKit ${release.tag_name || opts.barekitTag} (${opts.platform}/${opts.engine}, ${zipFolder}/) staged`)
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
// Generated by wdk-setup. Do not edit by hand — re-run \`node Scripts/wdk-setup.js\`
// after changing wdk.config.js instead.
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
// Step 7 (macOS variant) — stage Tests/Resources/macos and run the existing
// prepare-macos-frameworks.sh. No satellite package here — this feeds
// wdk-core-swift's own `swift test`, not an Xcode embed phase.
// ---------------------------------------------------------------------------

function stageMacosAddons () {
  const prepareScript = path.join(ROOT, 'Scripts', 'prepare-macos-frameworks.sh')
  if (!fs.existsSync(prepareScript)) {
    fail(
      'Scripts/prepare-macos-frameworks.sh not found here. --platform macos expects to be ' +
      'run from wdk-core-swift\'s own repo root, not a consumer app — that script, and the ' +
      'Tests/WdkSwiftCoreTests target it feeds, only exist in wdk-core-swift itself.'
    )
  }

  const macosFrameworksDir = path.join(ROOT, 'Tests', 'Resources', 'macos', 'Frameworks')
  fs.mkdirSync(macosFrameworksDir, { recursive: true })

  const addonFiles = fs.readdirSync(ADDONS_DIR).filter((f) => f.endsWith('.framework'))
  if (addonFiles.length === 0) {
    fail(`No addon .framework bundles found in ${ADDONS_DIR} — nothing to stage for the macOS test suite.`)
  }

  // Same "refresh from scratch" reasoning as the iOS satellite package step —
  // a stale prior run's addon should never linger alongside this one.
  for (const entry of fs.readdirSync(macosFrameworksDir)) {
    fs.rmSync(path.join(macosFrameworksDir, entry), { recursive: true, force: true })
  }
  for (const entry of addonFiles) {
    fs.cpSync(path.join(ADDONS_DIR, entry), path.join(macosFrameworksDir, entry), { recursive: true })
  }
  log(`✓ staged ${addonFiles.length} addon frameworks into Tests/Resources/macos/Frameworks/`)

  // The worklet bundle goes next to the frameworks, not in them — the SDK's
  // test lookup (WdkSwiftCore.swift) reads Tests/Resources/macos/<name>.bundle,
  // and prepare-macos-frameworks.sh's own header says to copy it there. The
  // destination name is fixed on purpose: the tests look for
  // "wdk-worklet.macos" by name, whatever output.bundle happens to be called.
  const config = require(path.join(ROOT, 'wdk.config.js'))
  const configuredBundle = config.output?.bundle
  if (!configuredBundle) {
    fail('wdk.config.js has no output.bundle set — needed to stage the macOS test bundle.')
  }
  const bundleSrc = path.resolve(ROOT, configuredBundle)
  if (!fs.existsSync(bundleSrc)) {
    fail(`Expected the worklet bundle at ${bundleSrc} (output.bundle in wdk.config.js) but it isn't there.`)
  }
  const bundleDest = path.join(ROOT, 'Tests', 'Resources', 'macos', 'wdk-worklet.macos.bundle')
  fs.rmSync(bundleDest, { recursive: true, force: true })
  fs.cpSync(bundleSrc, bundleDest, { recursive: true })
  log(`✓ staged worklet bundle -> Tests/Resources/macos/wdk-worklet.macos.bundle`)

  log('Running Scripts/prepare-macos-frameworks.sh...')
  execFileSync(prepareScript, [], { cwd: ROOT, stdio: 'inherit' })
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
  // package.json is pure generated output now (see writePackageJsonAndInstall)
  // — it's not an independent input, so it isn't hashed here. The bundler
  // version actually used (the default included, so changing the default
  // re-runs setup), platform, and engine are real inputs that change what
  // gets produced.
  hash.update(JSON.stringify({
    tag: opts.barekitTag,
    dir: opts.barekitDir,
    bundlerRef: opts.bundlerRef || DEFAULT_BUNDLER_VERSION,
    platform: opts.platform,
    engine: opts.engine,
    extraPins: opts.extraPins
  }))
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

  FRAMEWORKS_DIR = opts.platform === 'macos'
    ? path.join(ROOT, 'Frameworks')
    : path.join(RUNTIME_DIR, 'Frameworks')

  if (!fs.existsSync(path.join(ROOT, 'wdk.config.js'))) {
    fail('No wdk.config.js in the current directory. Run this from your project root, next to wdk.config.js.')
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  ADDONS_DIR = resolveAddonsDir(opts.platform)
  const inputHash = computeInputHash(opts)
  const marker = readMarker()
  // What "nothing changed" means depends on platform: the iOS path's
  // deliverable is .wdk-runtime/Package.swift; the macOS path's is BOTH the
  // staged worklet bundle and a non-empty Tests/Resources/macos/Frameworks
  // (checking only the frameworks would let a run that never staged the
  // bundle look finished).
  const macosResourcesDir = path.join(ROOT, 'Tests', 'Resources', 'macos')
  const priorOutputExists = opts.platform === 'macos'
    ? fs.existsSync(path.join(macosResourcesDir, 'wdk-worklet.macos.bundle')) &&
      fs.existsSync(path.join(macosResourcesDir, 'Frameworks')) &&
      fs.readdirSync(path.join(macosResourcesDir, 'Frameworks')).length > 0
    : fs.existsSync(path.join(RUNTIME_DIR, 'Package.swift'))
  if (!opts.force && marker && marker.inputHash === inputHash && priorOutputExists) {
    log(`✓ Nothing changed since the last run (${marker.generatedAt}) — skipping. Use --force to regenerate anyway.`)
    return
  }

  log(`=== wdk-setup (platform: ${opts.platform}, engine: ${opts.engine}) ===\n`)

  writePackageJsonAndInstall(opts.bundlerRef, opts.extraPins)
  // Patched AFTER install, never before — writePackageJsonAndInstall wipes
  // node_modules and reinstalls fresh on every run, which would silently
  // undo an earlier patch and reintroduce the exact failure it fixes.
  patchDynamicImportValidator()

  runBundlerGenerate()
  await linkExtraModules(opts.platform)
  await fetchBareKit(opts)

  if (opts.platform === 'macos') {
    stageMacosAddons()
  } else {
    generateSatellitePackage()
  }
  writeMarker(inputHash)

  log('\n✅ wdk-setup complete.')
  if (opts.platform === 'macos') {
    log('   Run ./Scripts/test-with-frameworks.sh to execute the test suite.')
  } else {
    log('   Add .wdk-runtime as a local Swift package dependency (once), then build as usual.')
  }
  if (opts.engine === 'jsc') {
    log('   Known limitation (JSC): any feature that spins up a worker thread (bare-worker) will')
    log('   still crash until holepunchto/bare-node-runtime#13 and holepunchto/libjsc#26 land —')
    log('   use --engine v8 to work around this for now.')
  }
}

main().catch((err) => {
  fail(err.stack || String(err))
})
