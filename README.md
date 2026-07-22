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

Phases 0–3 are complete: the workspace, workflow state machines, Solidity contracts, and authenticated multi-recipient envelope encryption are implemented and tested. Phase 4 is in progress. Its local checkpoint can encrypt an invoice in the browser, store only its opaque envelope through the local API, and reopen it for an authorized payer.

The browser now connects to an injected EVM wallet, publishes a local encryption public key, and uses the Viem chain-record adapter to register, read, and approve invoice records through the Solidity `InvoiceRegistry`. The end-to-end integration test deploys the contract to Anvil and exercises encrypted creation, payer reopening, and wallet-signed approval across two accounts. API identity headers and browser-stored encryption keys remain development-only. This checkpoint is local development, not an Arc testnet deployment.

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

Run the local chain, deploy the registry, and start the web app and API in three terminals:

```bash
pnpm chain:node
```

```bash
pnpm chain:deploy
```

```bash
pnpm dev
```

The web app runs at `http://localhost:5173`; the API health endpoint runs at `http://localhost:3001/health`; and Anvil exposes the local RPC at `http://127.0.0.1:8545` on chain ID `31337`. The browser wallet will offer to add or switch to that local chain. Connect the payer once to publish its encryption public key, switch to the payee to create the invoice, then switch back to the payer to reopen and approve it.

The deployment command uses Anvil's publicly known first development key and deterministic first contract address. Never use that key outside a disposable local Anvil chain. Running and deploying this local checkpoint costs no real money.

## Privacy boundary

QuietPact does not describe ordinary Arc transfers as private. A commitment proves data integrity, not payment of a hidden amount. Native confidential-settlement language will remain disabled until an Arc testnet implementation is available and independently verified end to end.

## License

Apache-2.0
