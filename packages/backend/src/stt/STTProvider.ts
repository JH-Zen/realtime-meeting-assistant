import type { SttStatus, TranscriptSegment } from "@rcc/shared";

/**
 * The STT seam (design doc §16). Core modules never learn which engine produced a segment, so
 * sherpa-onnx, a cloud API and the mock are interchangeable. Third-party payload shapes stop at
 * the adapter that implements this interface.
 */
export interface STTProvider {
  readonly name: string;
  connect(): Promise<void>;
  sendAudio(data: ArrayBuffer): void;
  disconnect(): Promise<void>;
  onPartial(callback: (segment: TranscriptSegment) => void): void;
  onFinal(callback: (segment: TranscriptSegment) => void): void;
  /** Optional: providers that can report their own connection state (reconnect attempts, failure). */
  onStatus?(callback: (status: SttStatus) => void): void;
}
