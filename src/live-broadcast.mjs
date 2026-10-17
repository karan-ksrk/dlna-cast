const TS_PACKET_BYTES = 188;

/**
 * Fans one live MPEG-TS stream out to every connected HTTP client. Data is cut on TS packet boundaries, so a
 * client that joins late, or skips data because it fell behind, still receives whole packets it can resync on.
 */
export class LiveBroadcast {
  #clients = new Set();
  #remainder = Buffer.alloc(0);
  #ended = false;

  constructor({ maxBacklogBytes = 2 * 1024 * 1024 } = {}) {
    this.maxBacklogBytes = maxBacklogBytes;
    this.bytesSent = 0;
    this.skippedBytes = 0;
  }

  get clientCount() {
    return this.#clients.size;
  }

  push(chunk) {
    if (this.#ended) return;
    const data = this.#remainder.length ? Buffer.concat([this.#remainder, chunk]) : chunk;
    const usable = data.length - (data.length % TS_PACKET_BYTES);
    this.#remainder = Buffer.from(data.subarray(usable));
    if (usable === 0) return;
    const packets = data.subarray(0, usable);
    for (const client of this.#clients) {
      // A renderer that can't keep up loses whole packets instead of stalling the encoder or growing memory.
      if (client.writableLength > this.maxBacklogBytes) {
        this.skippedBytes += usable;
        continue;
      }
      client.write(packets);
      this.bytesSent += usable;
    }
  }

  subscribe(writable) {
    if (this.#ended) {
      writable.end();
      return () => {};
    }
    this.#clients.add(writable);
    const unsubscribe = () => this.#clients.delete(writable);
    writable.once("close", unsubscribe);
    return unsubscribe;
  }

  end() {
    this.#ended = true;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }
}
