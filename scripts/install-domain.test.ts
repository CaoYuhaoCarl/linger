import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./install-domain/worker";

const originFetch = vi.fn<typeof fetch>();
const shellHeaders = {
  "content-type": "text/x-shellscript",
  "cache-control": "public,max-age=60",
};

beforeEach(() => {
  originFetch.mockReset();
  vi.stubGlobal("fetch", originFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public shell downloads", () => {
  it.each([
    ["/install.sh", "simplex-installer"],
    ["/stack.sh", "localmodels"],
  ])("serves %s from the %s stable channel", async (path, channel) => {
    const script = Uint8Array.of(35, 33, 47, 98, 105, 110, 47, 115, 104, 10);
    originFetch.mockResolvedValue(
      new Response(script, { headers: shellHeaders }),
    );

    const response = await worker.fetch(
      new Request(`https://heylinger.com${path}?origin=ignored`, {
        headers: { Cookie: "local-only=1", Range: "bytes=0-2" },
      }),
    );

    expect(originFetch).toHaveBeenCalledExactlyOnceWith(
      `https://d2ikbbcl3j6jz9.cloudfront.net/cli/${channel}/stable${path}`,
      { method: "GET", redirect: "manual" },
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(script);
    expect(response.headers.get("cache-control")).toBe("public,max-age=60");
  });

  it("serves HEAD metadata without a script body", async () => {
    originFetch.mockResolvedValue(
      new Response(null, { headers: shellHeaders }),
    );

    const response = await worker.fetch(
      new Request("https://heylinger.com/stack.sh", { method: "HEAD" }),
    );

    expect(originFetch).toHaveBeenCalledExactlyOnceWith(
      "https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/stable/stack.sh",
      { method: "HEAD", redirect: "manual" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-shellscript");
    expect(response.body).toBeNull();
  });

  it.each(["/", "/stach.sh", "/stack.sh/extra", "/constructor"])(
    "does not fetch upstream for %s",
    async (path) => {
      const response = await worker.fetch(
        new Request(`https://heylinger.com${path}`),
      );

      expect(response.status).toBe(404);
      expect(originFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects writes before contacting the CDN", async () => {
    const response = await worker.fetch(
      new Request("https://heylinger.com/install.sh", { method: "POST" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(originFetch).not.toHaveBeenCalled();
  });

  it.each([
    [200, "text/html"],
    [404, "text/x-shellscript"],
    [503, "text/x-shellscript"],
  ])(
    "does not serve an upstream %i response of type %s",
    async (status, contentType) => {
      originFetch.mockResolvedValue(
        new Response("Not an installer", {
          status,
          headers: { "content-type": contentType },
        }),
      );

      const response = await worker.fetch(
        new Request("https://heylinger.com/install.sh"),
      );

      expect(response.status).toBe(502);
      expect(response.body).toBeNull();
    },
  );

  it("returns a download failure when the CDN is unreachable", async () => {
    originFetch.mockRejectedValue(new TypeError("Network error"));

    const response = await worker.fetch(
      new Request("https://heylinger.com/stack.sh"),
    );

    expect(response.status).toBe(502);
  });

  it("does not pass through a CDN redirect", async () => {
    originFetch.mockResolvedValue(
      Response.redirect("https://example.com/stack.sh"),
    );

    const response = await worker.fetch(
      new Request("https://heylinger.com/stack.sh"),
    );

    expect(response.status).toBe(502);
    expect(response.headers.has("location")).toBe(false);
  });
});
