import { config } from "./config.js";
import { ApiError } from "./http.js";

export const MAX_SPEECH_AUDIO_BYTES = 4 * 1024 * 1024;
const FORMATS: Record<string, { extension: string; signature: (audio: Buffer) => boolean }> = {
  "audio/ogg": { extension: "ogg", signature: (audio) => audio.subarray(0, 4).toString("ascii") === "OggS" },
  "audio/webm": { extension: "webm", signature: (audio) => audio.length >= 4 && audio.readUInt32BE(0) === 0x1a45dfa3 },
};

export function validateSpeechAudio(audio: Buffer, contentType: string) {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const format = FORMATS[mediaType];
  if (!format) throw new ApiError(415, "unsupported_audio_type", "Firefox voice typing supports OGG or WebM audio.");
  if (!audio.length || audio.length > MAX_SPEECH_AUDIO_BYTES) {
    throw new ApiError(413, "audio_size_invalid", "Keep voice recordings under 4 MB.");
  }
  if (!format.signature(audio)) throw new ApiError(415, "invalid_audio_file", "The recording could not be read. Please record it again.");
  return { mediaType, filename: `job-brief.${format.extension}` };
}

type TranscribeOptions = {
  apiKey?: string;
  model?: string;
  fetcher?: typeof fetch;
};

export async function transcribeSpeech(audio: Buffer, contentType: string, options: TranscribeOptions = {}) {
  const { mediaType, filename } = validateSpeechAudio(audio, contentType);
  const apiKey = options.apiKey ?? config.GROQ_API_KEY;
  const model = options.model ?? config.GROQ_STT_MODEL;
  if (!apiKey) throw new ApiError(503, "speech_unavailable", "Voice transcription is not available right now.");

  const form = new FormData();
  const audioBuffer = new ArrayBuffer(audio.byteLength);
  new Uint8Array(audioBuffer).set(audio);
  form.append("file", new Blob([audioBuffer], { type: mediaType }), filename);
  form.append("model", model);
  form.append("language", "en");
  form.append("response_format", "json");
  form.append("temperature", "0");

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ApiError(502, "speech_provider_unavailable", "Voice transcription could not reach the speech service. Please try again.");
  }

  if (!response.ok) {
    throw new ApiError(502, "speech_provider_error", "The speech service could not transcribe this recording. Please try again.");
  }
  const payload = await response.json().catch(() => ({})) as { text?: unknown };
  const transcript = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!transcript) throw new ApiError(502, "speech_transcription_empty", "No speech was detected. Please try recording again.");
  return { transcript: transcript.slice(0, 20_000) };
}
