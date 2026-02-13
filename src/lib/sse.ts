// SSE streaming helpers for the provisioning Worker

export class SSEWriter {
  private encoder = new TextEncoder();
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  public readable: ReadableStream<Uint8Array>;

  constructor() {
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  send(event: SSEEvent): void {
    if (!this.controller) return;
    const data = JSON.stringify(event);
    this.controller.enqueue(this.encoder.encode(`data: ${data}\n\n`));
  }

  close(): void {
    if (this.controller) {
      this.controller.close();
      this.controller = null;
    }
  }

  toResponse(): Response {
    return new Response(this.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

export interface SSEEvent {
  phase: string;
  status: "running" | "complete" | "error";
  message: string;
  data?: Record<string, unknown>;
}
