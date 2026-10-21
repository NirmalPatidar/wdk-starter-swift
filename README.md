# WDK Starter Swift

An iOS example for WDK (Wallet Development Kit) by Tether, demonstrating [WDK Swift Core](https://github.com/Tetherto/wdk-core-swift) integration.

For the broader WDK ecosystem, see the [WDK documentation](https://docs.wdk.tether.io/).

> **Building your own app with WdkSwiftCore, not just running this example?**
> See [wdk-core-swift's integration guide](https://github.com/Tetherto/wdk-core-swift#integration-guide) —
> this README only covers running this specific demo.

## Prerequisites

- **macOS** 14.0+ and **Xcode** 15.0+ (last verified with Xcode 27)
- **XcodeGen**: `brew install xcodegen`
- **Node.js** 18.3+ and npm — only used by the setup script
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
[why V8 is selected for now](#why-v8-is-selected-for-now-temporary)).

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
    targets: ["ios-arm64", "ios-arm64-simulator", "ios-x64-simulator"],
    swiftTarget: "wdk-starter-swift",
    convertEsmToCjs: false,
    linkAddons: true,
  },
};
```

### 3. Run setup

```bash
node Scripts/wdk-setup.js --platform ios --engine v8
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

## Why V8 is selected for now (temporary)

BareKit ships a V8 and a JavaScriptCore build, and the script defaults to JavaScriptCore. The JavaScriptCore build is reported to fail on iOS 26 (it works on iOS 18 and macOS; under investigation), so this example passes `--engine v8`. Drop the flag once JavaScriptCore works on iOS 26.

The script also pins `bare-node-runtime` to 1.5.0 for you: later versions load `bare-worker` on every start, which the JavaScriptCore port cannot run ([bare-node-runtime#13](https://github.com/holepunchto/bare-node-runtime/issues/13), [libjsc#26](https://github.com/holepunchto/libjsc/issues/26)). It installs the worklet bundler at an exact version (`1.0.0-beta.15`) rather than a range, because a newer release can change the config format (beta.15 did: it rejects `options.platforms` and uses `options.targets`).

## What has been verified

- Physical iPhone, Xcode 27: build, launch, create a new wallet, home screen with the configured networks. That run used BareKit v2.5.5 (V8 build) and an unreleased pre-release build of the worklet bundler, before it was published as 1.0.0-beta.15.
- The command above, as written (bundler 1.0.0-beta.15, BareKit v2.5.5): the same checks, on a physical iPhone.

Not yet verified: the iOS Simulator and iPad, and JavaScriptCore on a device.

## License

Apache-2.0
