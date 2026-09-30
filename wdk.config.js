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
