/**
 * @openrows/sdk: a typed client for the OpenRows REST API v1, for Node 20+ and browsers,
 * with no dependencies beyond `fetch`. Its types are generated from the API's contracts.
 *
 * @packageDocumentation
 */
export {
  Automations,
  BaseClient,
  type Bases,
  Comments,
  chunks,
  type Fields,
  OpenRows,
  Query,
  Table,
  Tables,
  Webhooks,
} from './client.js';
export { isOpenRowsError, OpenRowsError, type OpenRowsErrorDetail } from './errors.js';
export * from './generated/v1.js';
export { type ClientOptions, DEFAULT_BASE_URL, type Fetch } from './http.js';
export type * from './types.js';
