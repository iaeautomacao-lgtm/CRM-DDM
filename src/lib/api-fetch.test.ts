import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const refreshSession = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession,
      refreshSession,
    },
  }),
}));

const { apiFetch } = await import("./api-fetch");

function response(status: number) {
  return new Response(null, { status });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns non-401 responses without checking auth", async () => {
    const fetchMock = vi.fn(async () => response(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiFetch("/api/flows");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("retries one 401 when a browser session still exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });

    const res = await apiFetch("/api/flows", { cache: "no-store" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/flows",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("preserves method, body, and headers on the 401 retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Flow" }),
    };

    const res = await apiFetch("/api/flows", options);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/flows",
      expect.objectContaining({ ...options, credentials: "same-origin" }),
    );
  });

  it("returns the retry 401 when the server still rejects an existing browser session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(401));
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });

    const res = await apiFetch("/api/flows");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("returns the original 401 when there is no browser session", async () => {
    const fetchMock = vi.fn(async () => response(401));
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    const res = await apiFetch("/api/flows");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("lets network errors reject normally", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Network error");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/flows")).rejects.toThrow("Network error");
    expect(getSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
