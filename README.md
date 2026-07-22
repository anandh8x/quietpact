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

Phases 0–3 are complete: the workspace, workflow state machines, Solidity contracts, and authenticated multi-recipient envelope encryption are implemented and tested. Phase 4 is in progress. Its first local checkpoint can encrypt an invoice in the browser, store only its opaque envelope through the local API, and reopen it for an authorized payer.

This checkpoint is local development, not an Arc testnet deployment. Its chain-record adapter is still in memory while the Anvil adapter is built next.

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
```

Run the web app and API:

```bash
pnpm dev
```

The web app runs at `http://localhost:5173`; the API health endpoint runs at `http://localhost:3001/health`. The website includes the local encrypted-invoice checkpoint. Development identities are intentionally temporary and are not wallet authentication.

## Privacy boundary

QuietPact does not describe ordinary Arc transfers as private. A commitment proves data integrity, not payment of a hidden amount. Native confidential-settlement language will remain disabled until an Arc testnet implementation is available and independently verified end to end.

## License

Apache-2.0
