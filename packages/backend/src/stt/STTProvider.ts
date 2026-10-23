import type { AudioGapInput, AudioInputPosition, SttStatus, TranscriptSegment } from "@rcc/shared";

/**
 * The STT seam (design doc §16). Core modules never learn which engine produced a segment, so
 * sherpa-onnx, a cloud API and the mock are interchangeable. Third-party payload shapes stop at
 * the adapter that implements this interface.
 */
export interface STTProvider {
  readonly name: string;
  connect(signal?: AbortSignal): Promise<void>;
  sendAudio(data: ArrayBuffer, position?: AudioInputPosition): void;
  disconnect(): Promise<void>;
  /** Scripted input can freeze its clock; microphone input is gated by the recording controller. */
  pause?(): void;
  resume?(): void;
  onPartial(callback: (segment: TranscriptSegment) => void): void;
  onFinal(callback: (segment: TranscriptSegment) => void): void;
  /** Optional: providers that can report their own connection state (reconnect attempts, failure). */
  onStatus?(callback: (status: SttStatus) => void): void;
  onAudioGap?(callback: (gap: AudioGapInput) => void): void;
}
