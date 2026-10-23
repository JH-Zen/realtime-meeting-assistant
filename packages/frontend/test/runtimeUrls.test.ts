import { describe, expect, it } from "vitest";
import { backendUrls } from "../src/runtimeUrls";

describe("runtime backend address", () => {
  it("uses the actual desktop port for HTTP and WS", () => {
    expect(backendUrls("http://127.0.0.1:43921/")).toEqual({ apiBase: "http://127.0.0.1:43921", wsUrl: "ws://127.0.0.1:43921/ws" });
  });
  it("retains the Vite browser entry and explicit backend overrides", () => {
    expect(backendUrls("http://127.0.0.1:5173/", { dev: true }).apiBase).toBe("http://127.0.0.1:8787");
    expect(backendUrls("https://localhost/", { apiBase: "https://localhost:4321/" }).wsUrl).toBe("wss://localhost:4321/ws");
  });
});
