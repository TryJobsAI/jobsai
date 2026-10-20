import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ApiError } from "./http.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

function cloudinaryCredentials() {
  let cloudName = config.CLOUDINARY_CLOUD_NAME;
  let apiKey = config.CLOUDINARY_API_KEY;
  let apiSecret = config.CLOUDINARY_API_SECRET;
  if (config.CLOUDINARY_URL) {
    let parsed: URL;
    try { parsed = new URL(config.CLOUDINARY_URL); }
    catch { throw new ApiError(503, "media_storage_unavailable", "Image uploads are not configured correctly."); }
    if (parsed.protocol !== "cloudinary:" || !parsed.hostname || !parsed.username || !parsed.password)
      throw new ApiError(503, "media_storage_unavailable", "Image uploads are not configured correctly.");
    cloudName ||= parsed.hostname;
    apiKey ||= decodeURIComponent(parsed.username);
    apiSecret ||= decodeURIComponent(parsed.password);
  }
  if (!cloudName || !apiKey || !apiSecret)
    throw new ApiError(503, "media_storage_unavailable", "Image uploads are not configured yet.");
  return { cloudName, apiKey, apiSecret };
}

function hasValidImageSignature(bytes: Buffer, contentType: ImageContentType) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function validateSubmissionImage(bytes: Buffer, contentType: string): ImageContentType {
  if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType))
    throw new ApiError(415, "unsupported_image_type", "Upload a JPEG, PNG, WebP, or GIF image. Video files are not accepted.");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new ApiError(413, "image_size_invalid", "Each image must be between 1 byte and 5 MB.");
  if (!hasValidImageSignature(bytes, contentType as ImageContentType))
    throw new ApiError(415, "invalid_image_file", "The uploaded file does not match its image type.");
  return contentType as ImageContentType;
}

export async function uploadSubmissionImage(bytes: Buffer, contentType: string, jobId: string) {
  validateSubmissionImage(bytes, contentType);
  const { cloudName, apiKey, apiSecret } = cloudinaryCredentials();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `jobsai/submissions/${jobId}`;
  const publicId = randomUUID();
  const signatureBase = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash("sha1").update(signatureBase).digest("hex");
  const form = new FormData();
  const imageData = new Uint8Array(bytes.length);
  imageData.set(bytes);
  form.append("file", new Blob([imageData.buffer], { type: contentType }));
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("signature", signature);

  let response: Response;
  try {
    response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: "POST", body: form });
  } catch {
    throw new ApiError(502, "media_storage_unavailable", "The image could not be uploaded. Please try again.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "media_upload_failed", "Cloud image storage could not accept this image.");
  }
  let result: { secure_url?: unknown; format?: unknown; bytes?: unknown };
  try { result = await response.json() as typeof result; }
  catch { throw new ApiError(502, "media_upload_failed", "Cloud image storage returned an unreadable response."); }
  const expectedPrefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  if (typeof result.secure_url !== "string" || !result.secure_url.startsWith(expectedPrefix))
    throw new ApiError(502, "media_upload_failed", "Cloud image storage returned an invalid image URL.");
  return { url: result.secure_url, format: typeof result.format === "string" ? result.format : "image", bytes: typeof result.bytes === "number" ? result.bytes : bytes.length };
}
