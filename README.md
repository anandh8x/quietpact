# QuietPact

**Private commercial workflows, ready for Arc.**

QuietPact is an Arc-ready prototype for sealed-bid procurement and encrypted invoice coordination. It is designed to integrate with Arc's native privacy capabilities when they become publicly available.

> **Prototype privacy notice:** Invoice records can be encrypted offchain, and sealed bids remain hidden until reveal. Current prototype payments are public onchain. Arc Privacy is documented but not currently available, so this project does not claim confidential USDC settlement.

## What QuietPact provides

- Encrypted invoice records shared with authorized commercial parties.
- Public commitments that prove a record has not changed without publishing its contents.
- Sealed-bid procurement with bids hidden until the reveal period.
- Clearly labelled public Arc testnet payment references.
- A payment adapter designed for a future verified Arc Privacy integration.

## Current release

QuietPact `v0.1.0-testnet` is a working testnet prototype with:

- Live `InvoiceRegistry` and `SealedBidAuction` contracts on Arc Testnet.
- Browser-side multi-recipient encryption for invoice bodies.
- Wallet-authenticated invoice creation, retrieval, approval, and public payment references.
- Sealed-bid auction creation, encrypted opening backups, reveal, finalization, and bond withdrawal.
- Explicitly separate simulated payments and confirmed public-chain transfers.
- Persistent SQLite state, transactional migrations, backup and restore tooling, rate limits, readiness monitoring, and a reproducible SBOM.
- Responsive desktop and mobile workflows with automated accessibility and real-chain lifecycle tests.

The recorded Arc smoke run created, approved, and publicly referenced an invoice, then created an auction, committed and revealed a bid, finalized its winner, and withdrew its bond credit. Every recorded receipt succeeded. Public deployment and smoke evidence is committed under `deployments/`.

The browser connects to an injected EVM wallet and signs a one-time authentication challenge that sends no transaction. The API rejects challenge replay, stores only hashes of bearer tokens, and protects encrypted-envelope access with short-lived sessions. Invoice plaintext and raw bearer tokens are never stored.

Invoice leakage tests verify that a plaintext canary is absent from transaction input, receipt logs, contract state, API logs, public database rows, and serialized encrypted envelopes. Revealed bid amounts, bidder addresses, contract calls, timing, and current payment transfers remain public.

Testnet prototype.

## Next update

The next major feature update will begin when Arc Privacy becomes publicly available and can be verified end to end. In the meantime, QuietPact remains available as a working public-settlement testnet prototype.

## Development

Requirements:

- Node.js 22+
- pnpm 11+
- Foundry

Install and verify:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm verify
pnpm test:browser
pnpm contracts:test
pnpm test:chain
```

The browser suite starts isolated services on ports `4173`, `13001`, and `18545`, deploys fresh contracts, and removes its temporary database when it exits. Set `QUIETPACT_BROWSER_PATH` to use a specific Chromium or Chrome executable.

Run the local chain, deploy both workflow contracts, and start the web app and API in three terminals:

```bash
pnpm chain:node
```

```bash
pnpm chain:deploy
```

```bash
pnpm dev
```

The web app runs at `http://localhost:5173`; the API health endpoint runs at `http://localhost:3001/health`; and Anvil exposes the local RPC at `http://127.0.0.1:8545` on chain ID `31337`. The browser wallet will offer to add or switch to that local chain. Connecting requests one authentication signature that sends no transaction and costs no gas. Connect the payer once to publish its encryption public key, switch to the payee to create the invoice, then switch back to the payer to reopen and approve it. The payer can then create a no-transfer simulation or explicitly acknowledge and send a public local-ETH transfer before its confirmed hash is attached to the invoice.

The deployment command uses Anvil's publicly known first development key and deploys `InvoiceRegistry` followed by `SealedBidAuction` at their deterministic first and second contract addresses. Never use that key outside a disposable local Anvil chain. Running and deploying this local checkpoint costs no real money.

Local API state is stored under `.quietpact-data/`, which is ignored by Git. SQLite is the zero-setup local adapter, not a production storage claim.

## Security and recovery

The public [threat model](security/threat-model.json) records protected assets, trust boundaries, current controls, residual risks, and release blockers. The [independent review scope](security/review-scope.json) defines the exact areas, commands, deliverables, severity policy, and exit criteria for any future external review.

The generated [CycloneDX 1.6 SBOM](security/sbom.cdx.json) inventories the locked production dependency graph. Refresh and audit it with:

```bash
pnpm security:sbom
pnpm security:audit
```

CI rejects stale SBOM output and any current high or critical production dependency advisory. The latest audit on 2026-07-23 reported no known vulnerabilities.

Create an online, integrity-checked SQLite backup without stopping the API:

```bash
pnpm data:backup -- .quietpact-data/quietpact.sqlite .quietpact-data/backups/quietpact-backup.sqlite
```

Restore only while the API is stopped. Keep the old database as a rollback copy, then restore into the now-unused canonical path:

```bash
mv .quietpact-data/quietpact.sqlite .quietpact-data/quietpact.pre-restore.sqlite
pnpm data:restore -- .quietpact-data/backups/quietpact-backup.sqlite .quietpact-data/quietpact.sqlite
```

Both operations verify SQLite integrity, create mode-`0600` output, and refuse to overwrite an existing destination. Backups contain encrypted envelopes, public metadata, public encryption keys, and hashed authentication state. Store them privately even though invoice plaintext and raw session tokens are not present.

SQLite schema changes run as ordered transactions and advance `PRAGMA user_version`. The API migrates supported legacy schemas without dropping their projection data and refuses a database created by newer, incompatible application code.

The API readiness endpoint at `http://localhost:3001/ready` reports only schema version, database status, projector state, consecutive projector failures, last successful sync time, and uptime. It contains no workflow IDs, addresses, transaction hashes, RPC errors, or business-volume counts. Database failure or three consecutive projector failures returns HTTP `503`; a successful sync restores readiness automatically.

Start a completely disposable local demonstration with:

```bash
pnpm demo:local
```

The launcher builds and deploys both contracts, starts isolated Anvil, API, and website services on ports `18545`, `13001`, and `4173`, and prints the local URL plus Anvil's seeded development accounts. It stores state in a temporary directory and erases it when stopped. These accounts and their test ETH are public development fixtures. Never send them real assets or reuse their keys. CI verifies the same stack with `pnpm demo:check`.

## Arc Testnet

Arc Testnet uses chain ID `5042002`, the public RPC at `https://rpc.testnet.arc.network`, ArcScan at `https://testnet.arcscan.app`, and faucet USDC as its native gas token. Viem and EVM transaction values use 18 decimals for native USDC. QuietPact displays the asset as USDC, never ETH, when configured for Arc.

Run the read-only readiness check:

```bash
pnpm arc:check
```

Deploy through a browser wallet or encrypted Foundry keystore without placing a private key in an environment variable:

```bash
pnpm arc:deploy
```

The command refuses any RPC that is not chain `5042002`, builds with the pinned Foundry settings, waits for both receipts, verifies deployed bytecode, and generates `deployments/arc-testnet.json` plus `deployments/arc-testnet.env`. After deployment, run the local website and API against Arc Testnet with:

```bash
pnpm arc:dev
```

Current contracts:

- [`InvoiceRegistry` at `0xCe084c9358FBC5200415012885c2F0F0906d400C`](https://testnet.arcscan.app/address/0xCe084c9358FBC5200415012885c2F0F0906d400C)
- [`SealedBidAuction` at `0x0C83623d0abFca5e7ad6E6179bB45A3E70C6C9DA`](https://testnet.arcscan.app/address/0x0C83623d0abFca5e7ad6E6179bB45A3E70C6C9DA)

Re-run the resumable lifecycle smoke gate with an encrypted Foundry account:

```bash
pnpm arc:smoke
```

The hidden password prompt uses a private temporary file that is removed automatically. Successful public evidence is written to `deployments/arc-testnet-smoke.json`; any interrupted private checkpoint remains under ignored `.quietpact-data/`.

Testnet USDC has no real-world value. Use a dedicated testnet wallet. Do not use a wallet that holds real assets. Arc Privacy is currently unavailable, so all QuietPact contract calls, transfers, wallet addresses, timing, and revealed bids remain public.

## Privacy boundary

QuietPact does not describe ordinary Arc transfers as private. A commitment proves data integrity, not payment of a hidden amount. Native confidential-settlement language will remain disabled until an Arc testnet implementation is available and independently verified end to end. See the official [Arc privacy status](https://docs.arc.io/arc/concepts/opt-in-privacy) and [Arc Testnet connection details](https://docs.arc.io/arc/references/connect-to-arc).

## License

Apache-2.0
