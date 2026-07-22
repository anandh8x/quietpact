interface ImportMetaEnv {
  readonly VITE_QUIETPACT_API_URL?: string;
  readonly VITE_QUIETPACT_AUCTION_ADDRESS?: string;
  readonly VITE_QUIETPACT_CHAIN_ID?: string;
  readonly VITE_QUIETPACT_REGISTRY_ADDRESS?: string;
  readonly VITE_QUIETPACT_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
