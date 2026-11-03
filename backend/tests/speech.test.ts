import { describe, expect, test } from "bun:test";
import { MAX_SPEECH_AUDIO_BYTES, transcribeSpeech, validateSpeechAudio } from "../src/speech.js";

const ogg = Buffer.from("OggS" + "test audio");
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

function expectApiError(run: () => unknown, status: number, code: string) {
  try { run(); } catch (error) { expect(error).toMatchObject({ status, code }); return; }
  throw new Error(`Expected ${code}`);
}

describe("Firefox voice transcription", () => {
  test("accepts OGG and WebM recorder output with codec parameters", () => {
    expect(validateSpeechAudio(ogg, "audio/ogg;codecs=opus")).toEqual({ mediaType: "audio/ogg", filename: "job-brief.ogg" });
    expect(validateSpeechAudio(webm, "audio/webm;codecs=opus")).toEqual({ mediaType: "audio/webm", filename: "job-brief.webm" });
  });

  test("rejects unsupported types, invalid signatures, empty and oversized audio", () => {
    expectApiError(() => validateSpeechAudio(ogg, "audio/mpeg"), 415, "unsupported_audio_type");
    expectApiError(() => validateSpeechAudio(Buffer.from("not ogg"), "audio/ogg"), 415, "invalid_audio_file");
    expectApiError(() => validateSpeechAudio(Buffer.alloc(0), "audio/ogg"), 413, "audio_size_invalid");
    expectApiError(() => validateSpeechAudio(Buffer.alloc(MAX_SPEECH_AUDIO_BYTES + 1), "audio/ogg"), 413, "audio_size_invalid");
  });

  test("sends English audio to Groq and returns only the transcript", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await transcribeSpeech(ogg, "audio/ogg", {
      apiKey: "test-key",
      model: "test-whisper",
      fetcher: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({ text: "  Write a short product description.  " });
      },
    });
    const form = requestInit?.body as FormData;
    expect(requestUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer test-key");
    expect(form.get("model")).toBe("test-whisper");
    expect(form.get("language")).toBe("en");
    expect(form.get("response_format")).toBe("json");
    expect((form.get("file") as File).name).toBe("job-brief.ogg");
    expect(result).toEqual({ transcript: "Write a short product description." });
  });

  test("does not call the provider without a key", async () => {
    await expect(transcribeSpeech(ogg, "audio/ogg", { apiKey: "", fetcher: async () => { throw new Error("must not call"); } }))
      .rejects.toMatchObject({ status: 503, code: "speech_unavailable" });
  });

  test("converts provider/network failures and empty transcripts to safe API errors", async () => {
    await expect(transcribeSpeech(ogg, "audio/ogg", { apiKey: "test", fetcher: async () => new Response("secret provider details", { status: 500 }) }))
      .rejects.toMatchObject({ status: 502, code: "speech_provider_error" });
    await expect(transcribeSpeech(ogg, "audio/ogg", { apiKey: "test", fetcher: async () => { throw new Error("network details"); } }))
      .rejects.toMatchObject({ status: 502, code: "speech_provider_unavailable" });
    await expect(transcribeSpeech(ogg, "audio/ogg", { apiKey: "test", fetcher: async () => Response.json({ text: " " }) }))
      .rejects.toMatchObject({ status: 502, code: "speech_transcription_empty" });
  });
});
