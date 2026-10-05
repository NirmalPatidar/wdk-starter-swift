# WDK Starter Swift

A minimal iOS example demonstrating [WDK Swift Core](https://github.com/Tetherto/wdk-core-swift) integration.

> **Building your own app with WdkSwiftCore, not just running this example?**
> See [wdk-core-swift's integration guide](https://github.com/Tetherto/wdk-core-swift/blob/main/INTEGRATION.md) —
> this README only covers running this specific demo.

## Prerequisites

- **macOS** 14.0+ and **Xcode** 15.0+ (last verified with Xcode 27)
- **XcodeGen**: `brew install xcodegen`
- **Node.js** 18+ and npm — only used by the setup script
- Internet access to GitHub — setup downloads BareKit (~400 MB) and a pinned build of the worklet bundler

## Quick Start

### 1. Clone this repo

```bash
git clone https://github.com/tetherto/wdk-starter-swift.git
cd wdk-starter-swift
```

### 2. Check `wdk.config.js`

`wdk.config.js` is already in this repo. It enables Sepolia, Ethereum and Bitcoin. To use other
networks, edit the `networks` block — see the bundler's
[Swift quick start](https://github.com/tetherto/wdk-worklet-bundler#quick-start--swift--kotlin-json-rpc).
Leave `convertEsmToCjs: false`: that is correct for the V8 engine used below (see
[why the setup command needs two flags](#why-the-setup-command-needs-two-flags-temporary)).

```js
module.exports = {
  transport: "jsonrpc",
  networks: {
    sepolia:  { package: "@tetherto/wdk-wallet-evm" },
    ethereum: { package: "@tetherto/wdk-wallet-evm" },
    bitcoin:  { package: "@tetherto/wdk-wallet-btc" },
  },
  output: {
    bundle: "./wdk-worklet.mobile.bundle",
    addons: { ios: "./addons" },
    addonsYml: "./addons/addons.yml",
  },
  options: {
    platforms: ["ios"],
    swiftTarget: "wdk-starter-swift",
    convertEsmToCjs: false,
    linkAddons: true,
  },
};
```

### 3. Run setup

```bash
node Scripts/wdk-setup.js --platform ios --engine v8 \
  --bundler-ref github:tetherto/wdk-worklet-bundler#e0d4f599ff2db82ed3ffd94da7e278187ae20924
```

This installs the bundler locally, generates the worklet bundle and native addons, downloads
BareKit, and writes `.wdk-runtime` — a small local Swift package that `project.yml` depends on.
Run it **before** the next step: XcodeGen checks that `.wdk-runtime` exists before it generates anything.

`package.json`, `node_modules/` and `.wdk-runtime/` are generated output, git-ignored, and safe to delete.

### 4. Generate and open the Xcode project

```bash
xcodegen generate
open wdk-starter-swift.xcodeproj
```

Set your Team under Signing & Capabilities, choose a device, and press `Cmd+R`.

### 5. Re-running setup

Run the same command again after changing `wdk.config.js`. Add `--force` to regenerate even when
nothing changed.

## Why the setup command needs two flags (temporary)

Both flags work around problems that are being fixed upstream. Drop each one when the fix is released.

| Flag | Why it's needed | Drop it when |
| --- | --- | --- |
| `--engine v8` | BareKit ships two engine builds. The script defaults to JavaScriptCore, but JavaScriptCore's port lacks the `SharedArrayBuffer` binding that `bare-worker` needs ([libjsc#26](https://github.com/holepunchto/libjsc/issues/26)), and `bare-node-runtime` 1.5.1 loads `bare-worker` on every start ([bare-node-runtime#13](https://github.com/holepunchto/bare-node-runtime/issues/13)). V8 has neither problem. | Both issues are fixed and JavaScriptCore is verified on a device. |
| `--bundler-ref …#e0d4f59…` | The published bundler links a fixed list of native addons and misses ones that newer dependencies need. [PR #65](https://github.com/tetherto/wdk-worklet-bundler/pull/65) discovers them from the bundle instead. The reference is a full commit SHA on purpose: the PR's head moves, and it changed the config format on Oct 4. | PR #65 is released to npm. |

The script also pins `bare-node-runtime` to 1.5.0 for you, for the same reason as above.

## What has been verified

- Physical iPhone, Xcode 27: build, launch, create a new wallet, home screen with the configured networks.
- BareKit: the latest release at the time (v2.5.5), V8 build.

Not yet verified: the iOS Simulator and iPad, JavaScriptCore on a device, and the newest PR #65
commit (its config drops `options.platforms` in favour of `options.targets`).

## Known limitations

- On JavaScriptCore, anything that starts a worker thread (`bare-worker`) does not work yet. That is
  why this example uses V8.
- A SwiftPM command plugin (`swift package wdk-setup`) wraps the same script, but it has not been
  verified end to end. Use the `node` command above.

## License

Apache-2.0
