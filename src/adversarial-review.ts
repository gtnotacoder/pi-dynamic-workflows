/**
 * Adversarial review mode for workflows.
 * Agents cross-check each other's findings for higher quality results.
 */

export interface AdversarialReviewConfig {
  /** Number of independent reviewers per finding. */
  reviewerCount: number;
  /** Whether to filter out findings that don't survive cross-checking. */
  filterContested: boolean;
  /** Minimum agreement threshold (0-1). */
  agreementThreshold: number;
}

export interface AdversarialReviewCommandArgs {
  /** The task/question to investigate and review. */
  task: string;
  /** Number of independent skeptical reviewers per finding. */
  reviewers: number;
  /** Minimum real-vote ratio required for a finding to survive. */
  threshold: number;
  /** Whether reviewers should gather/use source evidence. */
  evidence: boolean;
  /** Evidence components enabled for the run. */
  evidenceComponents: string[];
  /** Unsupported components the user requested; ignored by the workflow. */
  unknownEvidenceComponents: string[];
}

const DEFAULT_REVIEWERS = 2;
const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_EVIDENCE_COMPONENTS = ["web_fetch", "github"] as const;
export const SUPPORTED_EVIDENCE_COMPONENTS = ["web_fetch", "github", "web_search"] as const;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseThreshold(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function splitComponents(value: string): string[] {
  return value
    .split(/[,+]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeEvidenceComponents(raw: string[]): { components: string[]; unknown: string[] } {
  const components = new Set<string>();
  const unknown = new Set<string>();

  for (const item of raw) {
    const key = item.trim().toLowerCase().replace(/-/g, "_");
    if (!key) continue;
    if (["none", "off", "false", "0", "no"].includes(key)) continue;
    if (key === "all") {
      components.add("web_fetch");
      components.add("github");
      components.add("web_search");
      continue;
    }
    if (["fetch", "web", "web_fetch", "url", "urls"].includes(key)) {
      components.add("web_fetch");
      continue;
    }
    if (["gh", "github", "github_fetch"].includes(key)) {
      components.add("github");
      // GitHub evidence is intentionally implemented through the no-key web_fetch tool.
      components.add("web_fetch");
      continue;
    }
    if (["search", "web_search", "bing"].includes(key)) {
      components.add("web_search");
      // Search results are only useful when the agent can fetch the sources it finds.
      components.add("web_fetch");
      continue;
    }
    unknown.add(item);
  }

  return { components: [...components], unknown: [...unknown] };
}

/**
 * Parse `/adversarial-review` arguments after the shared `--mode` flag has been stripped.
 *
 * Supported flags:
 * - `--evidence` enables the default no-key components: `web_fetch,github`
 * - `--evidence=web_fetch,github` picks components explicitly
 * - `--no-evidence` / `--evidence=off` disables evidence mode
 * - `--reviewers=N` / `--reviewers N`
 * - `--threshold=N` / `--threshold N`
 */
export function parseAdversarialReviewArgs(raw: string): AdversarialReviewCommandArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  let reviewers = DEFAULT_REVIEWERS;
  let threshold = DEFAULT_THRESHOLD;
  let evidence = false;
  let evidenceComponents: string[] = [];
  let unknownEvidenceComponents: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (tok === "--reviewers" || tok === "--reviewer-count") {
      reviewers = parsePositiveInt(tokens[++i], reviewers);
      continue;
    }
    if (tok.startsWith("--reviewers=") || tok.startsWith("--reviewer-count=")) {
      reviewers = parsePositiveInt(tok.slice(tok.indexOf("=") + 1), reviewers);
      continue;
    }
    if (tok === "--threshold" || tok === "--agreement-threshold") {
      threshold = parseThreshold(tokens[++i], threshold);
      continue;
    }
    if (tok.startsWith("--threshold=") || tok.startsWith("--agreement-threshold=")) {
      threshold = parseThreshold(tok.slice(tok.indexOf("=") + 1), threshold);
      continue;
    }
    if (tok === "--no-evidence") {
      evidence = false;
      evidenceComponents = [];
      unknownEvidenceComponents = [];
      continue;
    }
    if (tok === "--evidence") {
      evidence = true;
      const normalized = normalizeEvidenceComponents([...DEFAULT_EVIDENCE_COMPONENTS]);
      evidenceComponents = normalized.components;
      unknownEvidenceComponents = normalized.unknown;
      continue;
    }
    if (tok.startsWith("--evidence=")) {
      const value = tok.slice("--evidence=".length);
      if (["none", "off", "false", "0", "no"].includes(value.trim().toLowerCase())) {
        evidence = false;
        evidenceComponents = [];
        unknownEvidenceComponents = [];
      } else {
        const normalized = normalizeEvidenceComponents(splitComponents(value));
        evidence = normalized.components.length > 0;
        evidenceComponents = normalized.components;
        unknownEvidenceComponents = normalized.unknown;
      }
      continue;
    }
    if (tok.startsWith("--evidence-components=")) {
      const normalized = normalizeEvidenceComponents(splitComponents(tok.slice("--evidence-components=".length)));
      evidence = normalized.components.length > 0;
      evidenceComponents = normalized.components;
      unknownEvidenceComponents = normalized.unknown;
      continue;
    }
    positional.push(tok);
  }

  return {
    task: positional.join(" "),
    reviewers,
    threshold,
    evidence,
    evidenceComponents,
    unknownEvidenceComponents,
  };
}

/**
 * Generate an adversarial-review workflow. The script is static and reads its
 * inputs from `args` (task/reviewers/threshold/evidence/evidenceComponents) — no
 * string interpolation.
 *
 * Baseline mode preserves the original behavior: investigate, then independently
 * refute each finding. Evidence mode adds a source-ledger phase before refutation.
 */
export function generateAdversarialReviewWorkflow(): string {
  return `export const meta = {
  name: 'adversarial_review',
  description: 'Adversarial review: findings cross-checked by independent skeptics',
  phases: [
    { title: 'Investigate' },
    { title: 'Evidence' },
    { title: 'Refute' },
    { title: 'Consensus' },
  ],
}

const task = (args && args.task) || ''
const reviewers = (args && args.reviewers) || 2
const threshold = (args && args.threshold) || 0.5
const evidence = Boolean(args && args.evidence)
const components = Array.isArray(args && args.evidenceComponents) ? args.evidenceComponents : []

phase('Investigate')
const investigation = await agent(
  'Investigate the following and list concrete, individually-checkable findings. ' +
  'Prefer findings that can be verified or falsified independently.\\n' + task,
  {
    label: 'investigate',
    tier: 'medium',
    schema: {
      type: 'object',
      properties: { findings: { type: 'array', items: { type: 'string' } } },
      required: ['findings'],
    },
  }
)
const findings = investigation && Array.isArray(investigation.findings)
  ? investigation.findings.map((f) => String(f)).filter(Boolean)
  : []

phase('Evidence')
let evidenceLedgers = []
if (evidence && findings.length) {
  evidenceLedgers = await parallel(findings.map((f, i) => () =>
    agent(
      'Collect a compact source ledger for this finding.\\n\\n' +
      'TASK: ' + task + '\\n' +
      'FINDING: ' + f + '\\n\\n' +
      'Enabled evidence components JSON: ' + JSON.stringify(components) + '\\n' +
      'Rules:\\n' +
      '- Use only enabled components.\\n' +
      '- web_fetch: fetch URLs already present in the task/finding, or URLs found by web_search when web_search is enabled.\\n' +
      '- github: GitHub URLs require no API key; prefer raw.githubusercontent.com for blob/file URLs when possible, or fetch the GitHub URL directly.\\n' +
      '- If web_search is not enabled, do not perform open-web discovery; just fetch known URLs.\\n' +
      '- Quote only short snippets that directly support or refute the finding.\\n' +
      '- If no usable source is available, return an empty sources array and explain that briefly.',
      {
        label: 'evidence ' + (i + 1),
        tier: 'small',
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  quote: { type: 'string' },
                  supports: { type: 'boolean' },
                  note: { type: 'string' },
                },
                required: ['url', 'supports'],
              },
            },
          },
          required: ['summary', 'sources'],
        },
      }
    )
  ))
} else {
  log(evidence ? 'Evidence requested, but there were no findings to source.' : 'Evidence collection disabled.')
}

phase('Refute')
const judged = await parallel(findings.map((f, i) => () =>
  parallel(Array.from({ length: reviewers }, (_, r) => () => {
    const ledger = evidenceLedgers[i] || { summary: '', sources: [] }
    const evidenceBlock = evidence
      ? 'EVIDENCE LEDGER JSON:\\n' + JSON.stringify(ledger) + '\\n\\n' +
        'Ground your verdict in this ledger when it is relevant. You may fetch listed URLs again if needed. ' +
        'If the ledger is empty or weak, say so and default to real=false when uncertain.\\n\\n'
      : 'Evidence mode is OFF. Use repository/context tools if useful, but default to real=false when uncertain.\\n\\n'
    return agent(
      'You are a skeptical reviewer. Try to REFUTE this finding for the task below. ' +
      'Default to real=false when uncertain. Investigate with the available tools if needed.\\n\\n' +
      'TASK: ' + task + '\\nFINDING: ' + f + '\\n\\n' + evidenceBlock,
      {
        label: 'refute ' + (i + 1) + '.' + (r + 1),
        tier: 'medium',
        schema: {
          type: 'object',
          properties: {
            real: { type: 'boolean' },
            reason: { type: 'string' },
            evidenceUsed: { type: 'array', items: { type: 'string' } },
          },
          required: ['real'],
        },
      }
    )
  })).then((votes) => {
    const valid = votes.filter(Boolean)
    const realCount = valid.filter((v) => v && v.real).length
    const ratio = valid.length ? realCount / valid.length : 0
    return {
      finding: f,
      evidence: evidenceLedgers[i] || null,
      votes: valid,
      realVotes: realCount,
      totalVotes: valid.length,
      survives: ratio >= threshold,
    }
  })
))

const survivors = judged.filter((j) => j && j.survives)

phase('Consensus')
const report = await agent(
  'Write a final adversarial review report. Include ONLY the findings that survived adversarial review, ' +
  'each with a short justification. If evidence mode was enabled, cite source URLs from the source ledgers where available. ' +
  'Note how many findings were discarded and why.\\n\\n' +
  'REVIEW JSON:\\n' + JSON.stringify({ evidence, components, total: findings.length, judged, survivors }),
  { label: 'consensus', tier: 'big' }
)

return { total: findings.length, evidence, evidenceComponents: components, judged, survivors, report }`;
}

/**
 * Generate a multi-perspective analysis workflow.
 */
export function generateMultiPerspectiveWorkflow(topic: string, perspectives: string[]): string {
  const perspectiveAgents = perspectives
    .map(
      (p, _i) =>
        `  () => agent('Analyze from ${p} perspective: ' + topic, { label: '${p.toLowerCase().replace(/\s+/g, "-")}' }),`,
    )
    .join("\n");

  return `export const meta = {
  name: 'multi_perspective_analysis',
  description: 'Analyze from ${perspectives.length} different perspectives',
  phases: [
    { title: 'Perspective Analysis' },
    { title: 'Synthesis' },
  ],
};

phase('Perspective Analysis');
const topic = '${topic.replace(/'/g, "\\'")}';
const analyses = await parallel([
${perspectiveAgents}
]);

phase('Synthesis');
const synthesis = await agent(
  'Synthesize these different perspectives into a balanced analysis:\\n' +
  'Analyses: ' + JSON.stringify(analyses) + '\\n' +
  'Topic: ' + topic,
  { label: 'synthesizer' }
);

return { analyses, synthesis };`;
}
