import { describe, expect, it } from "vitest";

import { poolObservationHeaders } from "./pool-response-headers.js";

describe("poolObservationHeaders", () => {
  it("omits headers when not eligible or missing", () => {
    expect(poolObservationHeaders(undefined)).toEqual({});
    expect(
      poolObservationHeaders({
        eligible: false,
        hit: false,
        idle: 0,
        warming: 0,
        checkedOut: 0,
        coldSpawn: false,
      }),
    ).toEqual({});
  });

  it("exposes hit=1 without miss reason", () => {
    expect(
      poolObservationHeaders({
        eligible: true,
        hit: true,
        idle: 1,
        warming: 0,
        checkedOut: 0,
        coldSpawn: false,
      }),
    ).toEqual({ "X-Cursor-Proxy-Pool-Hit": "1" });
  });

  it("exposes hit=0 and miss reason", () => {
    expect(
      poolObservationHeaders({
        eligible: true,
        hit: false,
        missReason: "empty",
        idle: 0,
        warming: 1,
        checkedOut: 0,
        coldSpawn: true,
      }),
    ).toEqual({
      "X-Cursor-Proxy-Pool-Hit": "0",
      "X-Cursor-Proxy-Pool-Miss-Reason": "empty",
    });
  });
});
