// Main-process engine client contract. Implemented by electron/engine/ (the
// supervisor + NDJSON client); consumed by ipc.ts, the MCP server and the
// built-in agent. All calls resolve to ActionResult — never throw.

import type { ActionResult, EngineStatus } from '@shared/types';
import type { EngineEvent, EngineRequest, RenderRequest, RenderResult, Analysis, SampleInfo } from '@shared/engine/protocol';

export interface EngineClient {
  /** Send a raw protocol request (id assigned internally). Default timeout 5 s (render: none). */
  request<T = unknown>(req: EngineRequest, timeoutMs?: number): Promise<ActionResult<T>>;
  status(): EngineStatus;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  onEvent(cb: (e: EngineEvent) => void): () => void;
  /** ws://127.0.0.1:<port>/?token=..., or null while not running. */
  telemetryUrl(): string | null;
  /** Offline render (WAV). Resolves when finished. */
  render(job: RenderRequest): Promise<ActionResult<RenderResult>>;
  analyzeFile(path: string): Promise<ActionResult<Analysis>>;
  sampleInfo(path: string): Promise<ActionResult<SampleInfo>>;
  restart(): Promise<ActionResult>;
}
