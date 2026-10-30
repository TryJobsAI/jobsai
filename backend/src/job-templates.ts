import type { jobCategories } from "./job-input.js";

export type JobTemplate = {
  id: string;
  name: string;
  summary: string;
  title: string;
  description: string;
  category: (typeof jobCategories)[number];
  acceptanceCriteria: string[];
};

// Text in [square brackets] is a placeholder the client replaces before creating the job.
export const jobTemplates: readonly JobTemplate[] = Object.freeze([
  {
    id: "cv-rewrite",
    name: "CV rewrite",
    summary: "Rewrite a CV for a target role using only facts the client provides.",
    title: "Rewrite my CV for a [target role] position",
    description: "Rewrite my CV so it is tailored to [target role] roles in [industry]. I will provide my current CV and a link to one job posting I am applying for.\n\nUse only facts from my current CV. Do not invent jobs, dates, titles, numbers, or skills; if something important seems missing, list it as a question in your delivery notes.\n\nDeliver the rewritten CV as an editable Google Doc or DOCX file, plus a short list of the main changes you made.",
    category: "writing",
    acceptanceCriteria: [
      "Fits on no more than 2 pages",
      "Uses only facts from the CV I provided",
      "Includes a summary section aimed at the [target role] role",
      "Delivered as an editable Google Doc or DOCX file",
      "Includes a list of the main changes and any open questions",
    ],
  },
  {
    id: "article",
    name: "Article or social thread",
    summary: "A researched article or numbered thread with cited sources.",
    title: "Write a [word count]-word article about [topic]",
    description: "Write an article about [topic] for [audience]. I will provide [any notes, links, or examples you want used, or say the worker should start from scratch].\n\nThe article should explain [the main point or question] in plain language, using public sources the worker can cite.\n\nDeliver it as a Markdown file or Google Doc with a title, short introduction, subheadings, and a list of source links at the end.",
    category: "writing",
    acceptanceCriteria: [
      "Between [word count minus 10%] and [word count plus 10%] words",
      "Cites at least 3 public sources with working links",
      "Includes a title, introduction, and at least 3 subheadings",
      "Contains no copied passages longer than one sentence",
      "Delivered as a Markdown file or Google Doc",
    ],
  },
  {
    id: "translation",
    name: "Menu or listing translation",
    summary: "Translate a menu, listing, or short document while keeping prices and names intact.",
    title: "Translate my [document type] from [source language] into [target language]",
    description: "Translate my [document type] from [source language] into [target language] for [audience]. I will provide the original as a PDF or screenshot, plus a list of names that must stay untranslated.\n\nKeep prices, measurements, and allergen notes exactly as they are, and keep the original section order.\n\nDeliver the translation as an editable Google Doc or DOCX file that mirrors the layout of the original.",
    category: "writing",
    acceptanceCriteria: [
      "Includes every section and item from the original",
      "Prices, measurements, and allergen notes are unchanged",
      "Names on the provided list stay untranslated",
      "Follows the original section order",
      "Delivered as an editable Google Doc or DOCX file",
    ],
  },
  {
    id: "spreadsheet-cleanup",
    name: "Spreadsheet clean-up",
    summary: "Clean, de-duplicate, and standardize a spreadsheet. Not tax or financial advice.",
    title: "Clean up and standardize my [spreadsheet name] spreadsheet",
    description: "Clean up my [spreadsheet name] spreadsheet, which has about [number] rows. I will provide the file as a CSV or XLSX export.\n\nRemove exact duplicate rows, standardize dates to YYYY-MM-DD, trim extra spaces, and make column names consistent. Do not delete or change any values beyond formatting; flag suspected errors in a separate notes column instead.\n\nDeliver the cleaned file as XLSX or CSV, plus a short change log. This is data clean-up only, not tax or financial advice.",
    category: "data",
    acceptanceCriteria: [
      "Contains no exact duplicate rows",
      "All dates use the YYYY-MM-DD format",
      "No values are changed beyond formatting",
      "Suspected errors are listed in a notes column",
      "Delivered as an XLSX or CSV file with a change log",
    ],
  },
  {
    id: "pricing-research",
    name: "Market or pricing research table",
    summary: "Compare competitors from public pages in one sourced table.",
    title: "Build a pricing comparison table for [number] [product type] competitors",
    description: "Research [number] competitors that sell [product type] to [audience] and compare their public pricing. I will provide [a starting list of competitor names, or say the worker should choose them].\n\nUse only public pages such as pricing pages and official docs. Do not contact companies or collect personal data.\n\nDeliver a spreadsheet (Google Sheets or CSV) with one row per competitor and columns for plan names, prices, billing period, key limits, and the source URL with the date checked.",
    category: "research",
    acceptanceCriteria: [
      "Includes at least [number] competitors",
      "Each row lists a source URL and the date it was checked",
      "Uses only public pages",
      "Prices include the currency and billing period",
      "Delivered as a Google Sheet or CSV file",
    ],
  },
  {
    id: "landing-page",
    name: "Illustrated landing page",
    summary: "One responsive landing page with original illustrations and a single call to action.",
    title: "Design and build an illustrated landing page for [product name]",
    description: "Design and build one responsive landing page for [product name], aimed at [audience]. I will provide the product description, the call-to-action link, and our logo and brand colors.\n\nThe page needs a hero section with a headline and call-to-action button, a 3-step \"how it works\" section, a features section, and a footer. Illustrations must be original or licensed for commercial use.\n\nDeliver the page as an HTML/CSS file or static site folder, the source illustrations as SVG files, and a preview link or screenshots.",
    category: "design",
    acceptanceCriteria: [
      "Includes a hero, a 3-step how-it-works section, a features section, and a footer",
      "Works on mobile (375px wide) and desktop (1440px wide) without horizontal scrolling",
      "All illustrations are original or commercially licensed, with licenses listed",
      "The call-to-action button links to the URL I provided",
      "Delivered as HTML/CSS with SVG source files and a preview link or screenshots",
    ],
  },
  {
    id: "product-descriptions",
    name: "Product description set",
    summary: "A consistent set of product descriptions for a store or marketplace listing.",
    title: "Write [number] product descriptions for my [store type] store",
    description: "Write [number] product descriptions for my [store type] store. I will provide a spreadsheet with each product's name, key features, materials, and price, plus 2 example descriptions in our brand voice.\n\nEach description should explain who the product is for and its main benefits without making claims that are not in the spreadsheet.\n\nDeliver the descriptions as a CSV or Google Sheet with one row per product, matching the product names I provided.",
    category: "writing",
    acceptanceCriteria: [
      "Includes a description for each of the [number] products",
      "Each description is between 80 and 150 words",
      "Uses no claims that are not in the provided spreadsheet",
      "Product names match the provided spreadsheet exactly",
      "Delivered as a CSV or Google Sheet",
    ],
  },
  {
    id: "image-set",
    name: "Image set",
    summary: "A set of generated or designed images in a consistent style.",
    title: "Create a set of [number] images for [use, such as social posts]",
    description: "Create [number] images for [use, such as social posts or a blog] in a consistent style. I will provide our brand colors, 2 or 3 reference images for the style, and a short line describing each image.\n\nImages must not include real people's likenesses, trademarked characters, or logos from other brands.\n\nDeliver PNG files at [width x height] pixels, named to match the descriptions I provided.",
    category: "image_generation",
    acceptanceCriteria: [
      "Includes all [number] images",
      "Each image is a PNG at [width x height] pixels",
      "Uses the provided brand colors",
      "Contains no real people's likenesses or other brands' logos",
      "File names match the provided descriptions",
    ],
  },
  {
    id: "bug-fix",
    name: "Bug fix",
    summary: "Fix one reproducible bug in an existing codebase, with a test.",
    title: "Fix [short bug description] in my [language or framework] app",
    description: "Fix this bug in my [language or framework] app: [what happens, and what should happen instead]. I will provide access to the repository, steps to reproduce the bug, and the command that runs the tests.\n\nKeep the change focused on this bug. Do not upgrade dependencies or reformat unrelated files.\n\nDeliver a pull request or patch file with the fix, a test that fails before the fix and passes after it, and a short explanation of the cause.",
    category: "coding",
    acceptanceCriteria: [
      "The steps to reproduce no longer show the bug",
      "Includes a test that fails before the fix and passes after it",
      "All existing tests still pass",
      "Changes only files related to the bug",
      "Delivered as a pull request or patch file with an explanation of the cause",
    ],
  },
]);
