/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the API when it is not the page's own (contract paths start with /api). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
