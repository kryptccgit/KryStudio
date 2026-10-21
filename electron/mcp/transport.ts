// An MCP Transport over one named-pipe connection: newline-delimited JSON-RPC
// (the stdio framing; the spec says custom byte streams SHOULD reuse it).
// The krypt hello/auth line is consumed before this transport sees the socket.
//
// Framing is linear in the message size (chunks are collected and joined
// once per line), so a large request such as import_audio with ~80 MB of
// base64 audio costs one copy, not one per chunk. A line over the cap is
// skipped and answered with a JSON-RPC error naming the limit; the
// connection stays open.

import type { Socket } from 'node:net';
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';
import { MAX_MCP_MESSAGE_BYTES } from './types';

const MB = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
/** Bytes kept from the start of an oversized line to find its request id. */
const HEAD = 4096;

export class PipeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  /** The current (unterminated) line, as received. */
  private chunks: Buffer[] = [];
  private size = 0;
  /** Set while skipping the rest of an oversized line: its first bytes (for the id) and its length so far. */
  private skipping: { head: Buffer; bytes: number } | null = null;
  private started = false;
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly initial: Buffer,
    /** Sees every inbound message first (client identity tracking). */
    private readonly onInbound?: (m: JSONRPCMessage) => void,
    /** Largest accepted line (tests use a small one). */
    private readonly maxBytes = MAX_MCP_MESSAGE_BYTES,
  ) {}

  private readonly ondata = (chunk: Buffer): void => {
    let from = 0;
    while (!this.closed) {
      const nl = chunk.indexOf(0x0a, from);
      const part = chunk.subarray(from, nl === -1 ? chunk.length : nl);
      if (this.skipping) {
        this.skipping.bytes += part.length;
        if (this.skipping.head.length < HEAD) this.skipping.head = Buffer.concat([this.skipping.head, part.subarray(0, HEAD - this.skipping.head.length)]);
      } else if (this.size + part.length > this.maxBytes) {
        const head = Buffer.concat([...this.chunks, part.subarray(0, HEAD)]).subarray(0, HEAD);
        this.skipping = { head, bytes: this.size + part.length };
        this.chunks = [];
        this.size = 0;
      } else if (part.length) {
        this.chunks.push(part);
        this.size += part.length;
      }
      if (nl === -1) return;
      from = nl + 1;
      if (this.skipping) {
        const s = this.skipping;
        this.skipping = null;
        this.rejectOversized(s.head, s.bytes);
      } else if (this.size) {
        const line = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
        this.chunks = [];
        this.size = 0;
        this.deliver(line);
      }
    }
  };

  private deliver(line: Buffer): void {
    const text = line.toString('utf8').replace(/\r$/, '');
    if (!text.trim()) return;
    let msg: JSONRPCMessage;
    try {
      msg = deserializeMessage(text);
    } catch (e) {
      this.onerror?.(e instanceof SyntaxError ? new Error(`Ignored a line that isn't JSON (${e.message})`) : (e as Error));
      return;
    }
    try {
      this.onInbound?.(msg);
    } catch {
      /* identity tracking must never break the session */
    }
    this.onmessage?.(msg);
  }

  /** A request over the cap: answer it with an error (when its id can be read) instead of dropping the connection. */
  private rejectOversized(head: Buffer, bytes: number): void {
    const message = `Request too large: ${MB(bytes)}; Krypt Studio accepts up to ${MB(this.maxBytes)} per message (import_audio: up to 60 MB of audio as base64). Send a shorter or compressed file (FLAC, MP3, OGG), or a path inside the user's Browser folders.`;
    this.onerror?.(new Error(message));
    const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(head.toString('utf8'));
    if (!m || this.socket.destroyed) return;
    let id: string | number;
    try {
      id = JSON.parse(m[1]) as string | number;
    } catch {
      return;
    }
    this.socket.write(serializeMessage({ jsonrpc: '2.0', id, error: { code: -32600, message } } as JSONRPCMessage));
  }

  private readonly onSocketError = (e: Error): void => {
    this.onerror?.(e);
  };

  private readonly onSocketClose = (): void => {
    void this.close();
  };

  async start(): Promise<void> {
    if (this.started) throw new Error('PipeTransport already started');
    this.started = true;
    this.socket.on('data', this.ondata);
    this.socket.on('error', this.onSocketError);
    this.socket.on('close', this.onSocketClose);
    this.socket.on('end', this.onSocketClose);
    if (this.initial.length) this.ondata(this.initial);
    if (this.socket.destroyed) setImmediate(this.onSocketClose);
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error('Pipe connection is closed'));
    return new Promise((resolve, reject) => {
      const ok = this.socket.write(serializeMessage(message), (err) => (err ? reject(err) : undefined));
      if (ok) resolve();
      else this.socket.once('drain', () => resolve());
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.off('data', this.ondata);
    this.socket.off('close', this.onSocketClose);
    this.socket.off('end', this.onSocketClose);
    this.chunks = [];
    this.size = 0;
    this.skipping = null;
    if (!this.socket.destroyed) this.socket.end();
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, 500).unref?.();
    this.onclose?.();
  }
}
