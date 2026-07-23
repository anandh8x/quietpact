/* global fetch, process */

const expectedChainId = 5_042_002;
const rpcUrl = process.env.QUIETPACT_ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const nativeUsdc = "0x3600000000000000000000000000000000000000";

const [chainIdHex, blockNumberHex, nativeUsdcCode] = await Promise.all([
  rpc("eth_chainId"),
  rpc("eth_blockNumber"),
  rpc("eth_getCode", [nativeUsdc, "latest"]),
]);
const chainId = Number.parseInt(chainIdHex, 16);
if (chainId !== expectedChainId) {
  throw new Error(`Expected Arc Testnet chain ${expectedChainId}, received ${chainId}`);
}
if (nativeUsdcCode === "0x") {
  throw new Error(`Arc native USDC interface has no code at ${nativeUsdc}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      network: "Arc Testnet",
      chainId,
      rpcUrl,
      latestBlock: Number.parseInt(blockNumberHex, 16),
      nativeGasToken: "USDC",
      nativeUsdc,
      nativeUsdcInterfacePresent: true,
      explorer: "https://testnet.arcscan.app",
      privacy: "UNAVAILABLE_ROADMAP",
    },
    null,
    2,
  )}\n`,
);

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(`${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  if (typeof payload.result !== "string") throw new Error(`${method} returned an invalid result`);
  return payload.result;
}
