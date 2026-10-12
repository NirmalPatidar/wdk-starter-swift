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
