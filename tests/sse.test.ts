import { describe, it, expect } from "vitest";
import { SSEWriter } from "../src/lib/sse";

describe("SSEWriter", () => {
  it("creates a readable stream", () => {
    const sse = new SSEWriter();
    expect(sse.readable).toBeInstanceOf(ReadableStream);
  });

  it("toResponse() returns SSE response with correct headers", () => {
    const sse = new SSEWriter();
    const resp = sse.toResponse();
    expect(resp).toBeInstanceOf(Response);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
    expect(resp.headers.get("Cache-Control")).toBe("no-cache");
    expect(resp.headers.get("Connection")).toBe("keep-alive");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("send() writes SSE-formatted data to stream", async () => {
    const sse = new SSEWriter();
    const reader = sse.readable.getReader();

    sse.send({ phase: "test", status: "running", message: "hello" });
    sse.close();

    const chunks: string[] = [];
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const output = chunks.join("");
    expect(output).toContain("data: ");
    expect(output).toContain('"phase":"test"');
    expect(output).toContain('"status":"running"');
    expect(output).toContain('"message":"hello"');
    expect(output).toMatch(/data: .+\n\n/);
  });

  it("send() includes optional data field", async () => {
    const sse = new SSEWriter();
    const reader = sse.readable.getReader();

    sse.send({ phase: "p", status: "complete", message: "m", data: { key: "val" } });
    sse.close();

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const json = JSON.parse(text.replace("data: ", "").trim());
    expect(json.data).toEqual({ key: "val" });
  });

  it("close() ends the stream", async () => {
    const sse = new SSEWriter();
    const reader = sse.readable.getReader();

    sse.close();

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("send() after close() is a no-op", () => {
    const sse = new SSEWriter();
    sse.close();
    // Should not throw
    sse.send({ phase: "x", status: "running", message: "nope" });
  });

  it("double close() is safe", () => {
    const sse = new SSEWriter();
    sse.close();
    sse.close(); // Should not throw
  });

  it("multiple sends accumulate in order", async () => {
    const sse = new SSEWriter();
    const reader = sse.readable.getReader();

    sse.send({ phase: "a", status: "running", message: "first" });
    sse.send({ phase: "b", status: "complete", message: "second" });
    sse.close();

    const chunks: string[] = [];
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const output = chunks.join("");
    const firstIdx = output.indexOf('"phase":"a"');
    const secondIdx = output.indexOf('"phase":"b"');
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
