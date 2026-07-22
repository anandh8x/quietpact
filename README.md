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

QuietPact is in early development. The current repository contains the workspace foundation; product workflows and contracts are being built incrementally and test-first.

Arc public testnet only · unaudited · no real funds.

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

The web app runs at `http://localhost:5173`; the API health endpoint runs at `http://localhost:3001/health`.

## Privacy boundary

QuietPact does not describe ordinary Arc transfers as private. A commitment proves data integrity, not payment of a hidden amount. Native confidential-settlement language will remain disabled until an Arc testnet implementation is available and independently verified end to end.

## License

Apache-2.0
