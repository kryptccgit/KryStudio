import type { ActionResult, EngineStatus } from '@shared/types';
import type { EngineEvent, EngineRequest, RenderRequest, RenderResult, Analysis, SampleInfo } from '@shared/engine/protocol';

export interface EngineClient {
  request<T = unknown>(req: EngineRequest, timeoutMs?: number): Promise<ActionResult<T>>;
  status(): EngineStatus;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  onEvent(cb: (e: EngineEvent) => void): () => void;
  telemetryUrl(): string | null;
  render(job: RenderRequest): Promise<ActionResult<RenderResult>>;
  analyzeFile(path: string): Promise<ActionResult<Analysis>>;
  sampleInfo(path: string): Promise<ActionResult<SampleInfo>>;
  restart(): Promise<ActionResult>;
}
