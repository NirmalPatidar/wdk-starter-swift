# WDK Starter Swift

A minimal iOS example demonstrating [WDK Swift Core](https://github.com/Tetherto/wdk-core-swift) integration.

> **Building your own app with WdkSwiftCore, not just running this example?**
> See [wdk-core-swift's integration guide](https://github.com/Tetherto/wdk-core-swift/blob/main/INTEGRATION.md) —
> this README only covers running this specific demo.

## Known limitation

Tapping **Create new wallet** or **Import Wallet** currently crashes — any
wallet initialization hits a worker-thread/addon-resolution gap in Bare's
runtime itself, not something specific to this app or its setup. Every other
part of the app (once past wallet initialization) is unaffected. Tracked
upstream; see `wdk-core-swift`'s
[INTEGRATION.md](https://github.com/Tetherto/wdk-core-swift/blob/main/INTEGRATION.md#before-you-start-one-known-limitation)
for the full detail.

## Prerequisites

- **macOS** 14.0+
- **Xcode** 15.0+
- **XcodeGen**: `brew install xcodegen`
- **Node.js** 18+ and npm (only needed to run the setup script)

## Quick Start

### 1. Clone this repo

```bash
git clone https://github.com/tetherto/wdk-starter-swift.git
cd wdk-starter-swift
```

### 2. Create `wdk.config.js`

This example enables Ethereum and Bitcoin. Adjust the `networks` block if you
need a different set — see the bundler's
[Swift quick start](https://github.com/tetherto/wdk-worklet-bundler#quick-start--swift--kotlin-json-rpc)
for the full reference.

```bash
cat > wdk.config.js << 'WDK_CONFIG_EOF'
module.exports = {
  transport: "jsonrpc",
  networks: {
    ethereum: { package: "@tetherto/wdk-wallet-evm" },
    bitcoin: { package: "@tetherto/wdk-wallet-btc" },
  },
  output: {
    bundle: "./wdk-worklet.mobile.bundle",
    addons: { ios: "./addons" },
    addonsYml: "./addons/addons.yml",
  },
  options: {
    platforms: ["ios"],
    swiftTarget: "wdk-starter-swift",
    convertEsmToCjs: true, // required: JavaScriptCore cannot load ES modules from the bundle
  },
};
WDK_CONFIG_EOF
```

### 3. Run setup

`Scripts/wdk-setup.js` is already part of this repo — it fetches BareKit,
generates the worklet bundle and native addons, and produces the local
`.wdk-runtime` package `project.yml` depends on.

```bash
node Scripts/wdk-setup.js --barekit-tag v2.3.0
```

Run this **before** the next step — XcodeGen validates `.wdk-runtime` exists
before it will generate anything.

### 4. Generate and open the Xcode project

```bash
xcodegen generate
open wdk-starter-swift.xcodeproj
```

Set your Team under Signing & Capabilities, select a device or simulator,
and press `Cmd+R`.

### 5. Re-running setup later

If you change `wdk.config.js` after the project already exists (different
networks, a new BareKit tag), re-run setup from inside Xcode's own terminal
instead of repeating step 3:

```bash
swift package wdk-setup --barekit-tag v2.3.0
```

If that refuses network access:

```bash
swift package --allow-network-connections all wdk-setup --barekit-tag v2.3.0
```

## License

Apache-2.0
