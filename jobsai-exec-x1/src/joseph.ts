import { parse } from "csv-parse/sync";
import { config } from "./config.js";
import type { AgentSubmission, WritingJob } from "./jobsai.js";

const MAX_CSV_BYTES = 12 * 1024 * 1024;
const MAX_CSV_ROWS = 100_000;
const CSV_TYPE = "text/csv";
type Fetcher = typeof fetch;

export function isDataJob(job: WritingJob) {
  return job.category === "data";
}

export function parseAndCleanCsv(input: string): { csv: string; findings: string[]; rowsBefore: number; rowsAfter: number } {
  let records: string[][];
  try {
    records = parse(input, { bom: true, skip_empty_lines: true, relax_column_count: false, max_record_size: 100_000 }) as string[][];
  } catch {
    throw new Error("The attached CSV has invalid quoting or rows with inconsistent column counts.");
  }
  if (records.length < 2) throw new Error("Attach a CSV with a header row and at least one data row.");
  if (records.length > MAX_CSV_ROWS + 1) throw new Error(`The CSV exceeds the ${MAX_CSV_ROWS.toLocaleString()} row limit.`);
  const headers = records[0].map((cell) => cell.trim());
  if (headers.some((cell) => !cell) || new Set(headers.map((h) => h.toLowerCase())).size !== headers.length)
    throw new Error("Every CSV column needs a distinct, non-empty header.");
  const width = headers.length;
  if (width > 200) throw new Error("The CSV exceeds the 200 column limit.");
  const rows = records.slice(1).map((row, index) => {
    if (row.length !== width) throw new Error(`CSV row ${index + 2} has ${row.length} cells; expected ${width}.`);
    return row.map((cell) => cell.trim());
  });
  if (!rows.length) throw new Error("The CSV has no data rows.");
  const seen = new Set<string>();
  let duplicateRows = 0;
  const cleaned = rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) { duplicateRows++; return false; }
    seen.add(key);
    return true;
  });
  const findings = [`Processed ${rows.length} data rows across ${width} columns.`, `Removed ${duplicateRows} exact duplicate row${duplicateRows === 1 ? "" : "s"}.`, "Trimmed leading and trailing whitespace from headers and cells."];
  headers.forEach((header, index) => {
    const values = cleaned.map((row) => row[index]);
    const missing = values.filter((value) => !value).length;
    if (missing) findings.push(`“${header}” has ${missing} blank value${missing === 1 ? "" : "s"} (${((missing / values.length) * 100).toFixed(1)}%).`);
    const nonEmpty = values.filter(Boolean);
    const parsedNumeric = nonEmpty.map((value) => {
      const normalized = value.replace(/,/g, "");
      const number = Number(normalized);
      return /^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized) && Number.isFinite(number) ? number : null;
    });
    const numeric = parsedNumeric.filter((value) => value !== null).length;
    if (nonEmpty.length > 0 && numeric > 0 && numeric < nonEmpty.length)
      findings.push(`“${header}” mixes numeric-looking and non-numeric values (${numeric} of ${nonEmpty.length} non-empty cells look numeric).`);
    if (numeric > 0) {
      const values = parsedNumeric.filter((value): value is number => value !== null);
      const sum = values.reduce((total, value) => total + value, 0);
      const minimum = values.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY);
      const maximum = values.reduce((current, value) => Math.max(current, value), Number.NEGATIVE_INFINITY);
      findings.push(`“${header}” numeric summary: count ${values.length}, sum ${Number(sum.toFixed(2))}, average ${Number((sum / values.length).toFixed(2))}, minimum ${minimum}, maximum ${maximum}.`);
    }
  });
  const escapeCsv = (value: string) => {
    // Prevent spreadsheet formula execution when a recipient opens the cleaned file.
    const safe = /^[=+@]/.test(value) || /^-[^\d.]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = [headers, ...cleaned].map((row) => row.map(escapeCsv).join(",")).join("\r\n") + "\r\n";
  return { csv, findings, rowsBefore: rows.length, rowsAfter: cleaned.length };
}

async function downloadSource(job: WritingJob, fetcher: Fetcher): Promise<Buffer> {
  if (!job.sourceFileUrl) throw new Error("Attach a CSV source file to this data job so Joseph can work on it.");
  const source = new URL(job.sourceFileUrl);
  if (source.hostname !== "res.cloudinary.com" || source.protocol !== "https:" || !new RegExp(`^/[^/]+/raw/upload/jobsai/job-sources/${job.id}/`).test(source.pathname))
    throw new Error("This job’s source link is not a supported JobsAI CSV attachment.");
  const response = await fetcher(source.toString(), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Joseph could not download the attached CSV.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_CSV_BYTES) throw new Error("The source CSV must be between 1 byte and 12 MB.");
  return bytes;
}

async function explainFindings(job: WritingJob, findings: string[], fetcher: Fetcher): Promise<string> {
  if (!config.openRouterApiKey) throw new Error("OpenRouter is not configured for Joseph.");
  const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${config.openRouterApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: config.openRouterDataModel, temperature: 0.1, messages: [
      { role: "system", content: "Write a concise, plain-language dataset analysis from the supplied verified facts. Do not invent results, claim transformations that are not listed, or infer sensitive attributes. Mention limitations when relevant." },
      { role: "user", content: JSON.stringify({ brief: job.description, acceptanceCriteria: job.acceptanceCriteria, revisionFeedback: job.revisionFeedback || null, verifiedFindings: findings }) },
    ] }), signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
  const text = body.choices?.[0]?.message?.content;
  if (!response.ok || typeof text !== "string" || !text.trim()) throw new Error(body.error?.message || "Joseph could not prepare the findings summary.");
  return text.trim().slice(0, 8_000);
}

export async function assessDataJob(job: WritingJob) {
  const suitable = isDataJob(job) && Boolean(job.sourceFileUrl) && /\b(clean|organize|duplicate|inconsisten|summari|spreadsheet|dataset|data|calculat|average|count|sum)\b/i.test(`${job.title} ${job.description}`);
  return { suitable, reason: suitable ? "CSV data analysis job with an attached source file." : "Joseph needs a data task with a CSV source attachment." };
}

export async function analyzeDataJob(job: WritingJob, token: string, upload: (jobId: string, token: string, bytes: Uint8Array, mediaType: string, fileName: string) => Promise<{ url: string }>, fetcher: Fetcher = fetch): Promise<AgentSubmission> {
  const source = await downloadSource(job, fetcher);
  const cleaned = parseAndCleanCsv(new TextDecoder("utf-8", { fatal: true }).decode(source));
  const report = await explainFindings(job, cleaned.findings, fetcher);
  const filename = `joseph-cleaned-${job.id}.csv`;
  const uploaded = await upload(job.id, token, new Uint8Array(Buffer.from(cleaned.csv)), CSV_TYPE, filename);
  return {
    summary: `Cleaned ${cleaned.rowsBefore} rows into ${cleaned.rowsAfter} rows. Removed ${cleaned.rowsBefore - cleaned.rowsAfter} exact duplicates and prepared a downloadable CSV with findings.`,
    deliverable: `## Cleaned dataset\n[Download the cleaned CSV](${uploaded.url})\n\n## Findings\n${report}\n\n## Verified cleanup\n${cleaned.findings.map((finding) => `- ${finding}`).join("\n")}\n\nRows before: ${cleaned.rowsBefore}. Rows after: ${cleaned.rowsAfter}.`,
    evidence: [uploaded.url],
  };
}
