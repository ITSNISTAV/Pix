/**
 * AI Reasoning Layer
 */

const BATCH_SIZE = 15;

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(diffs, systemicIssues) {
  const systemicContext = systemicIssues.length > 0
    ? `\nSYSTEMIC PATTERNS DETECTED (same property failing on 3+ nodes — likely a global CSS issue):\n${
        systemicIssues.map(s =>
          `- "${s.property}" fails on ${s.count} nodes: ${s.affectedNodes.join(', ')}`
        ).join('\n')
      }\n`
    : '';

  const nodeList = diffs.map((d, i) => {
    const issueLines = d.issues.map(iss =>
      `    - ${iss.property}: figma=${iss.figmaVal} → dom=${iss.domVal}${
        iss.delta != null ? ` (delta: ${iss.delta})` : ''
      } [${iss.severity}]`
    ).join('\n');

    return `Node ${i + 1}: "${d.figmaName}" <${d.domTag}>${
      d.isComposite ? ' (composite: merged Figma container+text)' : ''
    }
  Overall fidelity: ${(d.overallScore * 100).toFixed(1)}%
  Issues:
${issueLines}`;
  }).join('\n\n');

  return `You are a UI quality reviewer analyzing differences between a Figma design and its web implementation.

CONTEXT:
- Figma uses absolute coordinates and design-intent styles
- The DOM uses computed CSS which may inherit, override, or normalize values
- "composite" nodes = a Figma filled-rect + text label merged into one DOM element (e.g. a button)
- textColor mismatches on buttons are often intentional CSS
- backgroundColor on Figma text nodes is often the text fill, not a background

${systemicContext}

For each node below, return a JSON object with exactly these fields:
{
  "nodeIndex": <number, 1-based>,
  "severity": "critical" | "moderate" | "minor" | "intentional",
  "issue": "<one sentence>",
  "fix": "<one CSS fix or 'No fix needed'>",
  "isIntentional": <boolean>
}

Return ONLY a JSON array.

NODES TO ANALYZE:
${nodeList}`;
}

// ─── API Call ─────────────────────────────────────────────────────────────────

async function callClaudeAPI(prompt) {
  const key = process.env.GROQ_API_KEY?.trim();

  if (!key) {
    throw new Error("❌ GROQ_API_KEY missing or invalid");
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("❌ API ERROR:", err);
    throw new Error(`API error ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? '';

  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) {
      throw new Error("AI response is not an array");
    }
    return parsed;
  } catch (e) {
    console.error("❌ Failed to parse AI response:", clean);
    throw new Error("Invalid JSON from AI");
  }
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

async function processBatch(batch, systemicIssues, onProgress) {
  const prompt = buildPrompt(batch, systemicIssues);
  const results = await callClaudeAPI(prompt);

  return results.map((aiResult) => {
    if (!aiResult || typeof aiResult.nodeIndex !== 'number') {
      console.warn("⚠️ Invalid AI result:", aiResult);
      return null;
    }

    const original = batch[aiResult.nodeIndex - 1];

    if (!original) {
      console.warn("⚠️ No matching original for index:", aiResult.nodeIndex);
      return null;
    }

    return {
      figmaName: original.figmaName,
      domTag: original.domTag,
      isComposite: original.isComposite ?? false,
      overallScore: original.overallScore,

      rawIssues: original.issues,

      ai: {
        severity: aiResult.severity,
        issue: aiResult.issue,
        fix: aiResult.fix,
        isIntentional: aiResult.isIntentional ?? false,
      },
    };
  }).filter(Boolean); // remove nulls
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function reasonAboutDiffs(aggregatorReport, onProgress) {
  const diffsWithIssues = aggregatorReport.diffsForAI ?? [];

  if (diffsWithIssues.length === 0) {
    return {
      ...aggregatorReport,
      aiAnnotations: [],
      aiProcessed: 0,
    };
  }

  const systemicIssues = aggregatorReport.issues?.systemic ?? [];
  const annotations = [];

  for (let i = 0; i < diffsWithIssues.length; i += BATCH_SIZE) {
    const batch = diffsWithIssues.slice(i, i + BATCH_SIZE);
    const batchResults = await processBatch(batch, systemicIssues, onProgress);

    annotations.push(...batchResults);

    if (onProgress) {
      onProgress(
        Math.min(i + BATCH_SIZE, diffsWithIssues.length),
        diffsWithIssues.length
      );
    }
  }

  const realIssues = annotations.filter(a => !a.ai.isIntentional);
  const intentionalOnes = annotations.filter(a => a.ai.isIntentional);

  const severityOrder = { critical: 0, moderate: 1, minor: 2, intentional: 3 };

  const fixList = realIssues
    .sort((a, b) => (severityOrder[a.ai.severity] ?? 9) - (severityOrder[b.ai.severity] ?? 9))
    .map((a, i) => ({
      rank: i + 1,
      figmaName: a.figmaName,
      domTag: a.domTag,
      severity: a.ai.severity,
      issue: a.ai.issue,
      fix: a.ai.fix,
    }));

  return {
    grade: aggregatorReport.grade,
    label: aggregatorReport.label,
    scores: aggregatorReport.scores,
    coverage: aggregatorReport.coverage,

    issues: {
      ...aggregatorReport.issues,
      intentionalPatterns: intentionalOnes.length,
      realIssues: realIssues.length,
    },

    fixList,

    intentionalPatterns: intentionalOnes.map(a => ({
      figmaName: a.figmaName,
      domTag: a.domTag,
      note: a.ai.issue,
    })),

    aiAnnotations: annotations,
    aiProcessed: annotations.length,
  };
}

module.exports = { reasonAboutDiffs };