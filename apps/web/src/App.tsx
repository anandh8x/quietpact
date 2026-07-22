import { useState, type FormEvent } from "react";

import { address } from "@quietpact/domain";
import { createEnvelopeModule } from "@quietpact/envelope";
import {
  createEncryptedInvoiceModule,
  createHttpInvoiceBlobStore,
  createInMemoryInvoiceAdapters,
  type InvoiceParticipant,
} from "@quietpact/invoice";

const payerAddress = address("0x2000000000000000000000000000000000000002");
const payeeAddress = address("0x3000000000000000000000000000000000000003");

type DemoResult = Readonly<{
  id: string;
  commitment: string;
  amount: string;
  memo: string;
}>;

export function App() {
  const [amount, setAmount] = useState("1250.00");
  const [memo, setMemo] = useState("Quarterly security review");
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runDemo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const envelopes = await createEnvelopeModule();
      const payer: InvoiceParticipant = {
        address: payerAddress,
        encryption: envelopes.generateRecipientKeyPair(payerAddress),
      };
      const payee: InvoiceParticipant = {
        address: payeeAddress,
        encryption: envelopes.generateRecipientKeyPair(payeeAddress),
      };
      const { records } = createInMemoryInvoiceAdapters();
      const moduleFor = (actor: InvoiceParticipant) =>
        createEncryptedInvoiceModule({
          actor,
          chainId: 31_337n,
          registry: "0x1111111111111111111111111111111111111111",
          envelopes,
          records,
          blobs: createHttpInvoiceBlobStore({
            baseUrl: "/api",
            headers: () => ({ "x-quietpact-dev-wallet": actor.address }),
          }),
        });
      const id = randomHex32();
      const body = { amount, currency: "USDC", memo };
      const created = await moduleFor(payee).create({ id, payer, payee, body });
      const reopened = await moduleFor(payer).view<typeof body>(id);
      if (reopened.body === null) throw new Error("Payer could not decrypt the invoice");

      setResult({
        id,
        commitment: created.public.commitment,
        amount: reopened.body.amount,
        memo: reopened.body.memo,
      });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The local invoice demo failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <div className="status">Arc-ready prototype · Local development</div>
      <section className="hero">
        <p className="eyebrow">QuietPact</p>
        <h1>Private commercial workflows, ready for Arc.</h1>
        <p className="lede">
          Try the first encrypted-invoice slice. The browser encrypts the invoice before the local
          API receives it, then reopens it using the payer&apos;s recipient key.
        </p>
      </section>

      <section className="demo" aria-labelledby="demo-title">
        <div>
          <p className="eyebrow">Phase 4 prototype</p>
          <h2 id="demo-title">Create an encrypted invoice</h2>
          <p className="demo-copy">
            Local development identities only. No wallet transaction or payment is sent.
          </p>
        </div>
        <form onSubmit={(event) => void runDemo(event)}>
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
            {busy ? "Encrypting…" : "Encrypt and reopen locally"}
          </button>
        </form>

        {error ? <p className="result error">{error}</p> : null}
        {result ? (
          <div className="result" aria-live="polite">
            <strong>Encrypted invoice reopened by payer</strong>
            <span>
              {result.amount} USDC · {result.memo}
            </span>
            <code>{result.commitment}</code>
          </div>
        ) : null}
      </section>

      <aside className="notice" aria-label="Prototype privacy notice">
        <strong>Prototype privacy notice</strong>
        <span>
          Invoice bodies are encrypted offchain. Current Arc payments are public onchain, and
          contract activity is public too. This local demo uses development identities and is
          unaudited.
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
