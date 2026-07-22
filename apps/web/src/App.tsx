const capabilities = [
  "Encrypted invoice coordination",
  "Sealed-bid procurement",
  "Verifiable public commitments",
] as const;

export function App() {
  return (
    <main>
      <div className="status">Arc-ready prototype · Public testnet</div>
      <section className="hero">
        <p className="eyebrow">QuietPact</p>
        <h1>Private commercial workflows, ready for Arc.</h1>
        <p className="lede">
          Coordinate encrypted invoices and sealed bids today, with a clean path to native Arc
          privacy when it becomes available.
        </p>
        <ul>
          {capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </section>
      <aside className="notice" aria-label="Prototype privacy notice">
        <strong>Prototype privacy notice</strong>
        <span>
          Invoice records can be encrypted offchain. Current Arc payments are public onchain.
        </span>
      </aside>
      <footer>Arc public testnet · unaudited · no real funds</footer>
    </main>
  );
}
