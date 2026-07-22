# QuietPact

**Private commercial workflows, ready for Arc.**

QuietPact is an Arc-ready prototype for sealed-bid procurement and encrypted invoice coordination. It is designed to integrate with Arc's native privacy capabilities when they become publicly available.

> **Prototype privacy notice:** Invoice records can be encrypted offchain, and sealed bids remain hidden until reveal. Current Arc testnet payments are public onchain. QuietPact does not yet provide confidential USDC settlement.

## What we are building

- Encrypted invoice records shared with authorized commercial parties.
- Public commitments that prove a record has not changed without publishing its contents.
- Sealed-bid procurement with bids hidden until the reveal period.
- Clearly labelled public Arc testnet payment references.
- A payment adapter designed for a future verified Arc Privacy integration.

## Current status

Phases 0–5 are complete: the workspace, workflow state machines, Solidity contracts, authenticated multi-recipient envelope encryption, encrypted invoice slice, and sealed-bid procurement slice are implemented and tested locally.

The browser connects to an injected EVM wallet, signs a one-time API authentication challenge, publishes its encryption public key, and uses the Viem chain-record adapter to register, read, and approve invoice records through the Solidity `InvoiceRegistry`. The API verifies the wallet signature, rejects challenge replay, and protects encrypted-envelope access with a short-lived bearer session. Encrypted envelopes, public encryption keys, one-time challenges, hashed session tokens, and the public contract-event projection persist in a local SQLite database across API restarts; raw bearer tokens are never stored.

The Phase 4 leakage test deploys the contract to Anvil and exercises encrypted creation, payer reopening, wallet-signed approval, event projection, API retrieval, and safe replay after a local chain reset. It verifies that a plaintext canary is absent from transaction input, receipt logs, contract state, API logs, public database rows, and the serialized encrypted envelope.

The Phase 5 browser flow creates and reads auctions, commits fixed-bond bids, exports and imports encrypted bid-opening backups, reveals bids only during the reveal window, finalizes winners, and withdraws bond credits. Bid openings stored by the browser or exported to a file are AES-GCM encrypted using key material derived from a wallet signature; unlocking sends no transaction and costs no gas. A real Anvil integration test runs three bidders through the lifecycle, leaves one bidder unrevealed, verifies their bond forfeiture, and processes every available withdrawal. Revealed amounts and bidder addresses are intentionally public. Browser-stored private encryption keys remain local prototype infrastructure. This checkpoint is local development, not an Arc testnet deployment. Phase 6 adds explicit simulated and public payment adapters.

Local prototype · unaudited · no real funds.

## Development

Requirements:

- Node.js 22+
- pnpm 11+
- Foundry

Install and verify:

```bash
pnpm install
pnpm verify
pnpm contracts:test
pnpm test:chain
```

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

The web app runs at `http://localhost:5173`; the API health endpoint runs at `http://localhost:3001/health`; and Anvil exposes the local RPC at `http://127.0.0.1:8545` on chain ID `31337`. The browser wallet will offer to add or switch to that local chain. Connecting requests one authentication signature that sends no transaction and costs no gas. Connect the payer once to publish its encryption public key, switch to the payee to create the invoice, then switch back to the payer to reopen and approve it.

The deployment command uses Anvil's publicly known first development key and deploys `InvoiceRegistry` followed by `SealedBidAuction` at their deterministic first and second contract addresses. Never use that key outside a disposable local Anvil chain. Running and deploying this local checkpoint costs no real money.

Local API state is stored under `.quietpact-data/`, which is ignored by Git. SQLite is the zero-setup local adapter, not a production storage claim.

## Privacy boundary

QuietPact does not describe ordinary Arc transfers as private. A commitment proves data integrity, not payment of a hidden amount. Native confidential-settlement language will remain disabled until an Arc testnet implementation is available and independently verified end to end.

## License

Apache-2.0
