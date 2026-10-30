import { z } from "zod";

export const jobQualityInputSchema = z.object({
  title: z.string().max(500).default(""),
  description: z.string().max(20_000).default(""),
  acceptanceCriteria: z.array(z.string().max(500)).max(50).default([]),
  deadlineAt: z.string().max(100).nullish(),
});

export type JobQualityInput = z.infer<typeof jobQualityInputSchema>;
export type JobQualityCheck = { id: string; label: string; points: number; earned: number; passed: boolean; fix: string | null };
export type JobQualityReport = { score: number; grade: "strong" | "okay" | "needs_work"; checks: JobQualityCheck[] };

const DELIVERABLE_WORDS = /\b(deliver(?:ed|able)?s?|file|files|pdf|docx?|csv|xlsx|spreadsheet|html|css|figma|png|jpe?g|svg|markdown|google doc|repo(?:sitory)?|zip|link|url|slides?|deck|words?|format)\b/i;
const INPUT_WORDS = /\b(provide[ds]?|will share|i(?:'| wi)ll send|attached|attach|access to|using (?:my|our|the)|existing|current|input[s]?|source material|brand (?:colors|guide)|start from scratch)\b/i;
const MEASURABLE_WORDS = /\d|\b(at least|no more than|under|over|includes?|contains?|mentions?|works on|delivered as|links? to|pass(?:es)?|match(?:es)?|uses|lists?|listed|cites?|each|every|all|no|without|unchanged|stays?|remains?|exactly|only|follows?)\b/i;
const VAGUE_PHRASES = ["high quality", "high-quality", "good quality", "make it pop", "looks nice", "looks good", "amazing", "awesome", "professional looking", "asap", "as soon as possible", "etc", "and so on", "whatever you think", "best possible"];

function check(id: string, label: string, points: number, earned: number, fix: string): JobQualityCheck {
  const clamped = Math.max(0, Math.min(points, earned));
  return { id, label, points, earned: clamped, passed: clamped === points, fix: clamped === points ? null : fix };
}

export function scoreJobBrief(input: JobQualityInput, now = new Date()): JobQualityReport {
  const title = input.title.trim();
  const description = input.description.trim();
  const criteria = input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
  const text = `${title}\n${description}\n${criteria.join("\n")}`.toLowerCase();
  const titleWords = title.split(/\s+/).filter(Boolean).length;
  const measurable = criteria.filter((item) => MEASURABLE_WORDS.test(item)).length;
  const vague = VAGUE_PHRASES.filter((phrase) => new RegExp(`(^|[^a-z])${phrase.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(text));
  const deadline = input.deadlineAt ? new Date(input.deadlineAt) : null;

  const checks = [
    check("title", "Specific title", 10, title.length >= 15 && titleWords >= 3 ? 10 : title.length >= 3 ? 5 : 0,
      "Name the task and its output in 3 or more words, for example \"Translate a 2-page menu into Spanish\"."),
    check("description", "Detailed description", 15, description.length >= 200 ? 15 : description.length >= 80 ? 8 : 0,
      "Explain the goal, who it is for, and what a finished result looks like in at least a few sentences."),
    check("deliverable", "Deliverable format", 15, DELIVERABLE_WORDS.test(description) ? 15 : 0,
      "Say how the work should be delivered, such as a PDF, Google Doc, CSV file, Figma link, or word count."),
    check("inputs", "Inputs the worker gets", 10, INPUT_WORDS.test(description) ? 10 : 0,
      "List what you will provide, such as source text, files, brand colors, or access, or say the worker should start from scratch."),
    check("criteria_count", "Enough acceptance criteria", 15, criteria.length >= 3 && criteria.length <= 8 ? 15 : criteria.length > 8 ? 10 : criteria.length * 5,
      criteria.length > 8 ? "Keep to the 3 to 8 conditions that matter most so reviews stay clear." : "Add at least 3 acceptance criteria, one condition per line."),
    check("criteria_measurable", "Checkable criteria", 15, criteria.length ? Math.round(15 * measurable / criteria.length) : 0,
      "Make each criterion something you can check, using numbers or concrete terms like \"under 300 words\" or \"works on mobile\"."),
    check("vague", "No vague wording", 10, vague.length ? Math.max(0, 10 - vague.length * 5) : 10,
      `Replace vague wording (${vague.slice(0, 3).map((phrase) => `"${phrase}"`).join(", ") || "none"}) with specific requirements.`),
    check("deadline", "Deadline set", 10, deadline && Number.isFinite(deadline.getTime()) && deadline > now ? 10 : 0,
      "Set a deadline so workers know whether they can finish in time."),
  ];
  const placeholders = [...new Set(text.match(/\[[^\]\n]{1,80}\]/g) ?? [])];
  checks.push({
    id: "placeholders", label: "Template placeholders filled in", points: 0, earned: 0, passed: !placeholders.length,
    fix: placeholders.length ? `Replace the bracketed placeholders (${placeholders.slice(0, 3).join(", ")}) with your details.` : null,
  });
  const total = checks.reduce((sum, item) => sum + item.earned, 0);
  const score = placeholders.length ? Math.min(total, 45) : total;
  return { score, grade: score >= 80 ? "strong" : score >= 50 ? "okay" : "needs_work", checks };
}
