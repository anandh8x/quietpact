# QuietPact

**Private commercial workflows, ready for Arc.**

QuietPact is an Arc-ready prototype for sealed-bid procurement and encrypted invoice coordination. It is designed to integrate with Arc's native privacy capabilities when they become publicly available.

> **Prototype privacy notice:** Invoice records can be encrypted offchain, and sealed bids remain hidden until reveal. Current prototype payments are public onchain. This checkpoint runs locally and does not yet provide Arc testnet deployment or confidential USDC settlement.

## What we are building

- Encrypted invoice records shared with authorized commercial parties.
- Public commitments that prove a record has not changed without publishing its contents.
- Sealed-bid procurement with bids hidden until the reveal period.
- Clearly labelled public Arc testnet payment references.
- A payment adapter designed for a future verified Arc Privacy integration.

## Current status

Phases 0–7 are complete: the workspace, workflow state machines, Solidity contracts, authenticated multi-recipient envelope encryption, encrypted invoice slice, sealed-bid procurement slice, explicit payment adapters, and product-quality website are implemented and tested locally.

The browser connects to an injected EVM wallet, signs a one-time API authentication challenge, publishes its encryption public key, and uses the Viem chain-record adapter to register, read, and approve invoice records through the Solidity `InvoiceRegistry`. The API verifies the wallet signature, rejects challenge replay, and protects encrypted-envelope access with a short-lived bearer session. Encrypted envelopes, public encryption keys, one-time challenges, hashed session tokens, and the public contract-event projection persist in a local SQLite database across API restarts; raw bearer tokens are never stored.

The Phase 4 leakage test deploys the contract to Anvil and exercises encrypted creation, payer reopening, wallet-signed approval, event projection, API retrieval, and safe replay after a local chain reset. It verifies that a plaintext canary is absent from transaction input, receipt logs, contract state, API logs, public database rows, and the serialized encrypted envelope.

The Phase 5 browser flow creates and reads auctions, commits fixed-bond bids, exports and imports encrypted bid-opening backups, reveals bids only during the reveal window, finalizes winners, and withdraws bond credits. Bid openings stored by the browser or exported to a file are AES-GCM encrypted using key material derived from a wallet signature; unlocking sends no transaction and costs no gas. A real Anvil integration test runs three bidders through the lifecycle, leaves one bidder unrevealed, verifies their bond forfeiture, and processes every available withdrawal. Revealed amounts and bidder addresses are intentionally public. Browser-stored private encryption keys remain local prototype infrastructure. This checkpoint is local development, not an Arc testnet deployment.

The Phase 6 payment seam keeps simulations and real public-chain transfers different in TypeScript, browser persistence, status, labels, and reference format. A simulation is permanently `SIMULATED_NOT_BROADCAST`, cannot be attached to invoice accounting, and sends nothing. A public local-chain transfer requires an exact publicity acknowledgement before wallet signing, waits for confirmation, persists its real transaction hash separately, and only then attaches that hash to an approved invoice. The transfer amount is entered independently and is not compared with the encrypted invoice amount. The Anvil payment test verifies the recipient balance and confirmed transaction hash.

Phase 7 provides the responsive QuietPact website, explicit problem and purpose positioning, connected invoice and auction consoles, actionable wallet errors, persistent maturity and privacy notices, and keyboard-accessible workflow rails. Playwright runs the real encrypted-invoice and sealed-bid lifecycles against a disposable Anvil chain and API. Desktop and mobile tests cover product copy, wallet rejection, wrong-chain recovery, expired sessions, and automated WCAG A/AA checks.

Local prototype · unaudited · no real funds.

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

## Privacy boundary

QuietPact does not describe ordinary Arc transfers as private. A commitment proves data integrity, not payment of a hidden amount. Native confidential-settlement language will remain disabled until an Arc testnet implementation is available and independently verified end to end.

## License

Apache-2.0
