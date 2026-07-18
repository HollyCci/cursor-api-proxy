import type { OutgoingHttpHeaders } from "node:http";

import type { PoolRequestObservation } from "./pool-metrics.js";

/**
 * Response headers for ops / verify scripts (sync JSON responses).
 * Omitted when the request was not pool-eligible.
 */
export function poolObservationHeaders(
  obs: PoolRequestObservation | undefined,
): OutgoingHttpHeaders {
  if (!obs?.eligible) return {};
  const headers: OutgoingHttpHeaders = {
    "X-Cursor-Proxy-Pool-Hit": obs.hit ? "1" : "0",
  };
  if (!obs.hit && obs.missReason) {
    headers["X-Cursor-Proxy-Pool-Miss-Reason"] = obs.missReason;
  }
  return headers;
}
