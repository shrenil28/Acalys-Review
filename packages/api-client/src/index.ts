/**
 * @acalys/api-client — the typed SDK `apps/web` consumes.
 *
 * Generated from `@acalys/contracts/api/v1`'s route manifest, so the client and
 * the server it calls cannot describe different endpoints. It imports the
 * public API layer only: `@acalys/contracts/internal` is off limits here for
 * the same reason it is off limits in the UI, and dependency-cruiser enforces
 * it.
 */
export {
  createAcalysClient,
  callRoute,
  type AcalysClient,
  type AcalysClientOptions,
  type CallOptions,
  type QueryValue,
} from "./client.js";
export {
  fetchTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./transport.js";
export {
  AcalysApiError,
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
} from "./errors.js";
