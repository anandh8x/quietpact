import { useMemo, useState, type FormEvent } from "react";

import { createViemInvoiceRecords } from "@quietpact/chain-records";
import { address, type Address } from "@quietpact/domain";
import {
  createEnvelopeModule,
  type EnvelopeModule,
  type RecipientIdentity,
} from "@quietpact/envelope";
import {
  createEncryptedInvoiceModule,
  createHttpInvoiceBlobStore,
  type InvoiceParticipant,
  type InvoiceParty,
} from "@quietpact/invoice";

import {
  connectInjectedWallet,
  createApiSession,
  getEncryptionKey,
  loadOrCreateIdentity,
  publishEncryptionKey,
  type WalletSession,
} from "./wallet.js";

const apiUrl = import.meta.env.VITE_QUIETPACT_API_URL ?? "/api";
const publicPaymentNotice = "Payments are public onchain.";

type DemoResult = Readonly<{
  id: string;
  commitment: string;
  state: string;
  detail: string;
}>;

type ConnectedWallet = Readonly<{
  session: WalletSession;
  envelopes: EnvelopeModule;
  identity: RecipientIdentity;
  apiToken: string;
}>;

export function App() {
  const [amount, setAmount] = useState("1250.00");
  const [memo, setMemo] = useState("Quarterly security review");
  const [payerInput, setPayerInput] = useState("");
  const [invoiceInput, setInvoiceInput] = useState("");
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const actor = connected?.session.account ?? null;
  const invoiceModule = useMemo(() => {
    if (connected === null) return null;
    const participant: InvoiceParticipant = {
      address: connected.session.account,
      encryption: connected.identity,
    };
    return createEncryptedInvoiceModule({
      actor: participant,
      chainId: connected.session.chainId,
      registry: connected.session.registry,
      envelopes: connected.envelopes,
      records: createViemInvoiceRecords({
        registry: connected.session.registry,
        publicClient: connected.session.publicClient,
        walletClientFor: () => connected.session.walletClient,
      }),
      blobs: createHttpInvoiceBlobStore({
        baseUrl: apiUrl,
        headers: () => ({ authorization: `Bearer ${connected.apiToken}` }),
      }),
    });
  }, [connected]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await connectInjectedWallet();
      const envelopes = await createEnvelopeModule();
      const identity = loadOrCreateIdentity(session.account, envelopes);
      const apiToken = await createApiSession(apiUrl, session);
      await publishEncryptionKey(apiUrl, session.account, identity, apiToken);
      setConnected({ session, envelopes, identity, apiToken });
      setResult(null);
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const createInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      if (connected === null || invoiceModule === null) throw new Error("Connect a wallet first");
      const payerAddress = address(payerInput);
      if (payerAddress === connected.session.account) {
        throw new Error("Payer and payee must use different wallets");
      }
      const payerKey = await getEncryptionKey(apiUrl, payerAddress);
      const payer: InvoiceParty = {
        address: payerAddress,
        encryption: payerKey,
      };
      const payee: InvoiceParticipant = {
        address: connected.session.account,
        encryption: connected.identity,
      };
      const id = randomHex32();
      const body = { amount, currency: "USDC", memo };
      const created = await invoiceModule.create({ id, payer, payee, body });

      setResult({
        id,
        commitment: created.public.commitment,
        state: created.public.state,
        detail: `${amount} USDC · encrypted for ${shortAddress(payerAddress)}`,
      });
      setInvoiceInput(id);
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const openInvoice = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (invoiceModule === null) throw new Error("Connect a wallet first");
      const id = parseHex32(invoiceInput);
      const opened = approve
        ? await invoiceModule.act<{ amount: string; memo: string }>(id, { type: "approve" })
        : await invoiceModule.view<{ amount: string; memo: string }>(id);
      if (opened.body === null) throw new Error("This wallet is not an encrypted recipient");
      setResult({
        id,
        commitment: opened.public.commitment,
        state: opened.public.state,
        detail: `${opened.body.amount} USDC · ${opened.body.memo}`,
      });
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <div className="topline">
        <div className="status">Arc-ready prototype · Local development</div>
        <button className="wallet" disabled={busy} type="button" onClick={() => void connect()}>
          {actor === null ? "Connect wallet" : shortAddress(actor)}
        </button>
      </div>
      <section className="hero">
        <p className="eyebrow">QuietPact</p>
        <h1>Private commercial workflows, ready for Arc.</h1>
        <p className="lede">
          Connect two local-chain wallets to create, sign, reopen, and approve an encrypted invoice
          backed by the deployed InvoiceRegistry contract.
        </p>
      </section>

      <section className="demo" aria-labelledby="demo-title">
        <div>
          <p className="eyebrow">Phase 4 · Live local chain</p>
          <h2 id="demo-title">Encrypt, register, and approve</h2>
          <p className="demo-copy">
            Connect the future payer once to publish their encryption key. Then connect the payee to
            create the invoice and sign its public commitment transaction.
          </p>
        </div>
        <form onSubmit={(event) => void createInvoice(event)}>
          <label>
            Payer wallet
            <input
              required
              placeholder="0x…"
              value={payerInput}
              onChange={(event) => setPayerInput(event.target.value)}
            />
          </label>
          <label>
            Amount
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label>
            Private memo
            <textarea required value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>
          <button disabled={busy} type="submit">
            {busy ? "Waiting…" : "Encrypt and register"}
          </button>
        </form>

        <div className="invoice-actions">
          <label>
            Invoice ID
            <input
              placeholder="0x…"
              value={invoiceInput}
              onChange={(event) => setInvoiceInput(event.target.value)}
            />
          </label>
          <div className="action-row">
            <button disabled={busy} type="button" onClick={() => void openInvoice(false)}>
              Open invoice
            </button>
            <button disabled={busy} type="button" onClick={() => void openInvoice(true)}>
              Approve as payer
            </button>
          </div>
        </div>

        {error ? <p className="result error">{error}</p> : null}
        {result ? (
          <div className="result" aria-live="polite">
            <strong>{result.state}</strong>
            <span>{result.detail}</span>
            <code>{result.id}</code>
            <code>{result.commitment}</code>
          </div>
        ) : null}
      </section>

      <aside className="notice" aria-label="Prototype privacy notice">
        <strong>Prototype privacy notice</strong>
        <span>
          Invoice bodies are encrypted offchain; contract activity remains public.{" "}
          {publicPaymentNotice} Transactions are wallet-signed, but local encryption keys use
          browser storage and authenticated API sessions remain local and in memory. No payment is
          sent.
        </span>
      </aside>
      <footer>Local prototype · unaudited · no real funds</footer>
    </main>
  );
}

function randomHex32(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex32(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Invoice ID must be 32-byte hex");
  return value as `0x${string}`;
}

function shortAddress(value: Address): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The local invoice workflow failed";
}
