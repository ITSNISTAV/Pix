/**
 * aiReasoning.js  (updated — visual context in prompts)
 * ─────────────────────────────────────────────────────────────────────────────
 * Changes from original:
 *   - buildPrompt() now includes visualScore + pixelChangePct per node
 *   - AI can comment on rendering artifacts, anti-aliasing, image mismatches
 *   - "hiddenIssues" (good semantic score but bad visual) are flagged to the AI
 *   - All original logic preserved — backward compatible when visual data is absent
 */

'use strict';

const BATCH_SIZE = 15;

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(diffs, systemicIssues, visualDrift = null) {
  const systemicContext = systemicIssues.length > 0
    ? `\nSYSTEMIC PATTERNS DETECTED (same property failing on 3+ nodes — likely a global CSS issue):\n${
        systemicIssues.map(s =>
          `- "${s.property}" fails on ${s.count} nodes: ${s.affectedNodes.join(', ')}`
        ).join('\n')
      }\n`
    : '';

  // Flag nodes where visual score contradicts semantic score
  const hiddenIssuesContext = (visualDrift?.hiddenIssues?.length > 0)
    ? `\nVISUAL-ONLY ISSUES (semantic score OK but pixel diff is high — rendering artifacts):\n${
        visualDrift.hiddenIssues.map(h =>
          `- "${h.figmaName}": semantic=${(h.semanticScore * 100).toFixed(0)}% but ${h.pixelChangePct}% pixels differ`
        ).join('\n')
      }\n`
    : '';

  const nodeList = diffs.map((d, i) => {
    const issueLines = d.issues.map(iss =>
      `    - ${iss.property}: figma=${iss.figmaVal} → dom=${iss.domVal}${
        iss.delta != null ? ` (delta: ${iss.delta})` : ''
      } [${iss.severity}]`
    ).join('\n');

    // Visual context lines — only added when data exists
    const visualLines = (d.visualScore != null)
      ? `  Visual fidelity: ${(d.visualScore * 100).toFixed(1)}% (${d.pixelChangePct != null ? d.pixelChangePct + '% pixels differ' : 'n/a'})\n` +
        (d.pixelChangePct > 25 && d.overallScore > 0.80
          ? `  ⚠️  Visual-semantic mismatch: semantic looks OK but ${d.pixelChangePct}% of pixels differ — likely a rendering artifact\n`
          : '')
      : '';

    return `Node ${i + 1}: "${d.figmaName}" <${d.domTag}>${
      d.isComposite ? ' (composite: merged Figma container+text)' : ''
    }
  Semantic fidelity: ${(d.overallScore * 100).toFixed(1)}%  |  Final fidelity: ${d.finalScore != null ? (d.finalScore * 100).toFixed(1) + '%' : 'same as semantic'}
${visualLines}  Issues:
${issueLines}`;
  }).join('\n\n');

  return `You are a UI quality reviewer analyzing differences between a Figma design and its web implementation.

CONTEXT:
- Figma uses absolute coordinates and design-intent styles
- The DOM uses computed CSS which may inherit, override, or normalize values
- "composite" nodes = a Figma filled-rect + text label merged into one DOM element (e.g. a button)
- textColor mismatches on buttons are often intentional CSS (e.g. white text on orange button)
- backgroundColor on Figma text nodes is often the text fill, not a background
- Visual fidelity % = pixel-level comparison of screenshots (when available)
- A high pixel diff (>25%) with a good semantic score means a rendering artifact the JSON missed
- Anti-aliasing causes ~1–5% pixel diff — this is normal and should be classified as "intentional"

${systemicContext}${hiddenIssuesContext}

For each node below, return a JSON object with exactly these fields:
{
  "nodeIndex": <number, 1-based>,
  "severity": "critical" | "moderate" | "minor" | "intentional",
  "issue": "<one sentence describing the problem>",
  "fix": "<one CSS fix or 'No fix needed'>",
  "isIntentional": <boolean>,
  "visualNote": "<optional: comment on pixel diff if provided, else empty string>"
}

Return ONLY a JSON array. No markdown, no explanation.

NODES TO ANALYZE:
${nodeList}`;
}

// ─── API Call ─────────────────────────────────────────────────────────────────

async function callLLMAPI(prompt) {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('❌ GROQ_API_KEY missing or invalid');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('❌ API ERROR:', err);
    throw new Error(`API error ${response.status}`);
  }

  const data  = await response.json();
  const text  = data.choices?.[0]?.message?.content ?? '';
  const match = text.match(/\[[\s\S]*\]/);

  if (!match) {
    console.error('❌ No JSON array found in AI response:', text);
    throw new Error('Invalid JSON from AI');
  }

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error('AI response is not an array');
    return parsed;
  } catch (e) {
    console.error('❌ Failed to parse AI response:', match[0]);
    throw new Error('Invalid JSON from AI');
  }
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

async function processBatch(batch, systemicIssues, visualDrift) {
  const prompt = buildPrompt(batch, systemicIssues, visualDrift);
  const results = await callLLMAPI(prompt);

  return results.map((aiResult) => {
    if (!aiResult || typeof aiResult.nodeIndex !== 'number') {
      console.warn('⚠️ Invalid AI result:', aiResult);
      return null;
    }

    const original = batch[aiResult.nodeIndex - 1];
    if (!original) {
      console.warn('⚠️ No matching original for index:', aiResult.nodeIndex);
      return null;
    }

    return {
      figmaName:    original.figmaName,
      domTag:       original.domTag,
      isComposite:  original.isComposite ?? false,
      overallScore: original.overallScore,
      finalScore:   original.finalScore ?? original.overallScore,
      visualScore:  original.visualScore ?? null,
      pixelChangePct: original.pixelChangePct ?? null,

      rawIssues: original.issues,

      ai: {
        severity:      aiResult.severity,
        issue:         aiResult.issue,
        fix:           aiResult.fix,
        isIntentional: aiResult.isIntentional ?? false,
        visualNote:    aiResult.visualNote ?? '',
      },
    };
  }).filter(Boolean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function reasonAboutDiffs(aggregatorReport, onProgress) {
  const diffsWithIssues = aggregatorReport.diffsForAI ?? [];

  if (!diffsWithIssues.length) {
    return {
      ...aggregatorReport,
      aiAnnotations: [],
      aiProcessed: 0,
    };
  }

  const systemicIssues = aggregatorReport.issues?.systemic ?? [];
  const visualDrift    = aggregatorReport.visualDrift ?? null;
  const annotations    = [];

  for (let i = 0; i < diffsWithIssues.length; i += BATCH_SIZE) {
    const batch = diffsWithIssues.slice(i, i + BATCH_SIZE);
    const batchResults = await processBatch(batch, systemicIssues, visualDrift);
    annotations.push(...batchResults);

    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, diffsWithIssues.length), diffsWithIssues.length);
    }
  }

  const realIssues      = annotations.filter(a => !a.ai.isIntentional);
  const intentionalOnes = annotations.filter(a => a.ai.isIntentional);

  const severityOrder = { critical: 0, moderate: 1, minor: 2, intentional: 3 };

  const fixList = realIssues
    .sort((a, b) => (severityOrder[a.ai.severity] ?? 9) - (severityOrder[b.ai.severity] ?? 9))
    .map((a, i) => ({
      rank:           i + 1,
      figmaName:      a.figmaName,
      domTag:         a.domTag,
      severity:       a.ai.severity,
      issue:          a.ai.issue,
      fix:            a.ai.fix,
      visualNote:     a.ai.visualNote || null,
      semanticScore:  a.overallScore,
      finalScore:     a.finalScore,
      pixelChangePct: a.pixelChangePct,
    }));

  return {
    grade:  aggregatorReport.grade,
    label:  aggregatorReport.label,
    scores: aggregatorReport.scores,
    coverage: aggregatorReport.coverage,
    visualDrift: aggregatorReport.visualDrift,

    issues: {
      ...aggregatorReport.issues,
      intentionalPatterns: intentionalOnes.length,
      realIssues: realIssues.length,
    },

    fixList,

    intentionalPatterns: intentionalOnes.map(a => ({
      figmaName: a.figmaName,
      domTag:    a.domTag,
      note:      a.ai.issue,
    })),

    aiAnnotations: annotations,
    aiProcessed:   annotations.length,
  };
}

module.exports = { reasonAboutDiffs };