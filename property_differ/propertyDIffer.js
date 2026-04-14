/**
 * Property Differ
 * Compares matched Figma↔DOM node pairs across 4 property buckets:
 *   1. Geometry   — x, y, width, height
 *   2. Typography — fontSize, fontFamily, fontWeight, lineHeight, color, textAlign
 *   3. Color      — background fill, borderRadius, opacity
 *   4. Spacing    — padding, gap (layout)
 *
 * Each bucket produces a score 0–1 and a list of specific issues.
 * The overall node score is a weighted average of all buckets.
 *
 * Special handling for composite nodes (N:1 merged pairs) — properties
 * are sourced from the correct originating Figma node (container vs text).
 */

// ─── Weights ─────────────────────────────────────────────────────────────────
// Reflect how impactful each category of drift is visually

const BUCKET_WEIGHTS = {
  geometry:   0.25,
  typography: 0.35,  // highest — text rendering differences are most visible
  color:      0.25,
  spacing:    0.15,
};

// Thresholds below which a delta is considered negligible (sub-pixel rounding etc)
const TOLERANCES = {
  px: 2,          // position/size differences under 2px are noise
  fontSize: 1,    // 1px font size difference is acceptable
  lineHeight: 2,
  borderRadius: 1,
  opacity: 0.02,
  padding: 2,
  gap: 2,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Score a numeric delta as 0–1 where 0 = perfect match
// Uses a soft decay: small deltas score near 1, large ones approach 0
function scoreNumericDelta(delta, referenceValue, tolerance) {
  if (Math.abs(delta) <= tolerance) return 1;
  if (!referenceValue || referenceValue === 0) return delta === 0 ? 1 : 0;
  const pct = Math.abs(delta) / Math.abs(referenceValue);
  return Math.max(0, 1 - pct);
}

// Normalize hex colors for comparison — both to lowercase #rrggbb
function normalizeHex(hex) {
  if (!hex) return null;
  return hex.toLowerCase().replace(/^#/, '').padStart(6, '0');
}

function hexEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return normalizeHex(a) === normalizeHex(b);
}

// Normalize textAlign — Figma uses 'left'/'right'/'center', CSS uses 'start'/'end'
function normalizeTextAlign(val) {
  if (!val) return null;
  const map = { left: 'start', right: 'end', start: 'start', end: 'end', center: 'center' };
  return map[val.toLowerCase()] ?? val.toLowerCase();
}

// Build an issue object — used to populate the report
function issue(property, figmaVal, domVal, delta, severity) {
  return { property, figmaVal, domVal, delta, severity };
}

// Classify severity based on percentage delta
function classifySeverity(pctDelta) {
  if (pctDelta >= 0.30) return 'critical';
  if (pctDelta >= 0.10) return 'moderate';
  return 'minor';
}

// ─── Bucket 1: Geometry ───────────────────────────────────────────────────────

function diffGeometry(figma, dom) {
  const issues = [];

  // x/y position — we report absolute delta rather than scoring it
  // because coordinate drift is expected and was corrected during matching
  // What matters is w/h accuracy (the element rendered the right size)
  const dw = figma.w - dom.w;
  const dh = figma.h - dom.h;
  const dx = figma.x - dom.x;
  const dy = figma.y - dom.y;

  const wScore = scoreNumericDelta(dw, figma.w, TOLERANCES.px);
  const hScore = scoreNumericDelta(dh, figma.h, TOLERANCES.px);

  if (Math.abs(dw) > TOLERANCES.px) {
    issues.push(issue('width', figma.w, dom.w, dw,
      classifySeverity(Math.abs(dw) / figma.w)));
  }
  if (Math.abs(dh) > TOLERANCES.px) {
    issues.push(issue('height', figma.h, dom.h, dh,
      classifySeverity(Math.abs(dh) / figma.h)));
  }

  // Report position drift as info — not scored, just noted
  if (Math.abs(dx) > TOLERANCES.px || Math.abs(dy) > TOLERANCES.px) {
    issues.push(issue('position', `x:${figma.x} y:${figma.y}`, `x:${dom.x.toFixed(1)} y:${dom.y.toFixed(1)}`,
      `dx:${dx.toFixed(1)} dy:${dy.toFixed(1)}`, 'info'));
  }

  const score = (wScore + hScore) / 2;
  return { score, issues };
}

// ─── Bucket 2: Typography ─────────────────────────────────────────────────────

function diffTypography(figmaTypo, domTypo) {
  // Both null — not a text node, skip
  if (!figmaTypo && !domTypo) return { score: 1, issues: [], skipped: true };
  // One has typography, other doesn't — partial data
  if (!figmaTypo || !domTypo) return { score: 0.5, issues: [
    issue('typography', figmaTypo ? 'present' : 'missing', domTypo ? 'present' : 'missing', null, 'moderate')
  ]};

  const issues = [];
  const scores = [];

  // Font size — most impactful
  if (figmaTypo.fontSize != null && domTypo.fontSize != null) {
    const delta = figmaTypo.fontSize - domTypo.fontSize;
    const s = scoreNumericDelta(delta, figmaTypo.fontSize, TOLERANCES.fontSize);
    scores.push({ score: s, weight: 0.35 });
    if (Math.abs(delta) > TOLERANCES.fontSize) {
      issues.push(issue('fontSize', `${figmaTypo.fontSize}px`, `${domTypo.fontSize}px`, delta,
        classifySeverity(Math.abs(delta) / figmaTypo.fontSize)));
    }
  }

  // Font family
  if (figmaTypo.fontFamily && domTypo.fontFamily) {
    const match = figmaTypo.fontFamily.toLowerCase() === domTypo.fontFamily.toLowerCase();
    scores.push({ score: match ? 1 : 0, weight: 0.20 });
    if (!match) {
      issues.push(issue('fontFamily', figmaTypo.fontFamily, domTypo.fontFamily, null, 'moderate'));
    }
  }

  // Font weight
  if (figmaTypo.fontWeight != null && domTypo.fontWeight != null) {
    const match = figmaTypo.fontWeight === domTypo.fontWeight;
    scores.push({ score: match ? 1 : 0, weight: 0.15 });
    if (!match) {
      issues.push(issue('fontWeight', figmaTypo.fontWeight, domTypo.fontWeight,
        figmaTypo.fontWeight - domTypo.fontWeight, 'minor'));
    }
  }

  // Text color
  if (figmaTypo.color?.hex && domTypo.color?.hex) {
    const match = hexEqual(figmaTypo.color.hex, domTypo.color.hex);
    scores.push({ score: match ? 1 : 0, weight: 0.20 });
    if (!match) {
      issues.push(issue('textColor', figmaTypo.color.hex, domTypo.color.hex, null, 'critical'));
    }
  }

  // Text alignment
  if (figmaTypo.textAlign && domTypo.textAlign) {
    const fAlign = normalizeTextAlign(figmaTypo.textAlign);
    const dAlign = normalizeTextAlign(domTypo.textAlign);
    const match = fAlign === dAlign;
    scores.push({ score: match ? 1 : 0, weight: 0.10 });
    if (!match) {
      issues.push(issue('textAlign', figmaTypo.textAlign, domTypo.textAlign, null, 'minor'));
    }
  }

  // Line height — only if both have it
  if (figmaTypo.lineHeight != null && domTypo.lineHeight != null) {
    const delta = figmaTypo.lineHeight - domTypo.lineHeight;
    const s = scoreNumericDelta(delta, figmaTypo.lineHeight, TOLERANCES.lineHeight);
    scores.push({ score: s, weight: 0.05 });
    if (Math.abs(delta) > TOLERANCES.lineHeight) {
      issues.push(issue('lineHeight', `${figmaTypo.lineHeight}px`, `${domTypo.lineHeight}px`, delta, 'minor'));
    }
  }

  if (scores.length === 0) return { score: 1, issues: [] };

  const totalWeight = scores.reduce((s, x) => s + x.weight, 0);
  const score = scores.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;
  return { score, issues };
}

// ─── Bucket 3: Color & Visual ─────────────────────────────────────────────────

function diffColor(figma, dom) {
  const issues = [];
  const scores = [];

  // Background fill
  const figmaFill = figma.fill?.hex;
  const domFill = dom.fill?.hex;

  if (figmaFill && domFill) {
    const match = hexEqual(figmaFill, domFill);
    scores.push({ score: match ? 1 : 0, weight: 0.60 });
    if (!match) {
      issues.push(issue('backgroundColor', figmaFill, domFill, null, 'critical'));
    }
  } else if (figmaFill && !domFill) {
    // Figma has a fill, DOM doesn't — could be transparent or missing
    // Only flag if figma fill is not white (white = default background, often omitted in CSS)
    if (normalizeHex(figmaFill) !== 'ffffff') {
      scores.push({ score: 0.5, weight: 0.60 });
      issues.push(issue('backgroundColor', figmaFill, 'none', null, 'moderate'));
    } else {
      scores.push({ score: 1, weight: 0.60 }); // white fill on figma, transparent on dom = fine
    }
  } else if (!figmaFill && domFill && normalizeHex(domFill) !== 'ffffff') {
    scores.push({ score: 0.7, weight: 0.60 });
    issues.push(issue('backgroundColor', 'none', domFill, null, 'minor'));
  } else {
    scores.push({ score: 1, weight: 0.60 }); // both empty = fine
  }

  // Border radius
  const figmaRadius = figma.borderRadius ?? 0;
  const domRadius = dom.borderRadius ?? 0;
  const radiusDelta = figmaRadius - domRadius;
  const radiusScore = scoreNumericDelta(radiusDelta, Math.max(figmaRadius, 1), TOLERANCES.borderRadius);
  scores.push({ score: radiusScore, weight: 0.25 });
  if (Math.abs(radiusDelta) > TOLERANCES.borderRadius) {
    issues.push(issue('borderRadius', `${figmaRadius}px`, `${domRadius}px`, radiusDelta,
      classifySeverity(figmaRadius > 0 ? Math.abs(radiusDelta) / figmaRadius : 1)));
  }

  // Opacity
  const figmaOpacity = figma.opacity ?? 1;
  const domOpacity = dom.opacity ?? 1;
  const opacityDelta = figmaOpacity - domOpacity;
  const opacityScore = scoreNumericDelta(opacityDelta, 1, TOLERANCES.opacity);
  scores.push({ score: opacityScore, weight: 0.15 });
  if (Math.abs(opacityDelta) > TOLERANCES.opacity) {
    issues.push(issue('opacity', figmaOpacity, domOpacity, opacityDelta, 'minor'));
  }

  const totalWeight = scores.reduce((s, x) => s + x.weight, 0);
  const score = scores.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;
  return { score, issues };
}

// ─── Bucket 4: Spacing & Layout ───────────────────────────────────────────────

function diffSpacing(figmaLayout, domLayout) {
  // Neither has layout — not a flex container, skip
  if (!figmaLayout && !domLayout) return { score: 1, issues: [], skipped: true };

  // One has layout — the other rendered as block/static
  if (!figmaLayout || !domLayout) {
    return { score: 0.7, issues: [
      issue('layout', figmaLayout ? 'flex' : 'block', domLayout ? 'flex' : 'block', null, 'minor')
    ]};
  }

  const issues = [];
  const scores = [];

  // Flex direction
  if (figmaLayout.direction && domLayout.direction) {
    const match = figmaLayout.direction === domLayout.direction;
    scores.push({ score: match ? 1 : 0, weight: 0.25 });
    if (!match) {
      issues.push(issue('flexDirection', figmaLayout.direction, domLayout.direction, null, 'critical'));
    }
  }

  // Gap
  const figmaGap = figmaLayout.gap ?? 0;
  const domGap = domLayout.gap ?? 0;
  const gapDelta = figmaGap - domGap;
  const gapScore = scoreNumericDelta(gapDelta, Math.max(figmaGap, 1), TOLERANCES.gap);
  scores.push({ score: gapScore, weight: 0.25 });
  if (Math.abs(gapDelta) > TOLERANCES.gap) {
    issues.push(issue('gap', `${figmaGap}px`, `${domGap}px`, gapDelta,
      classifySeverity(figmaGap > 0 ? Math.abs(gapDelta) / figmaGap : 0.5)));
  }

  // Padding — compare each side
  const sides = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'];
  const paddingScores = [];
  for (const side of sides) {
    const fVal = figmaLayout[side] ?? 0;
    const dVal = domLayout[side] ?? 0;
    const delta = fVal - dVal;
    const s = scoreNumericDelta(delta, Math.max(fVal, 1), TOLERANCES.padding);
    paddingScores.push(s);
    if (Math.abs(delta) > TOLERANCES.padding) {
      issues.push(issue(side, `${fVal}px`, `${dVal}px`, delta,
        classifySeverity(fVal > 0 ? Math.abs(delta) / fVal : 0.5)));
    }
  }
  scores.push({ score: paddingScores.reduce((a, b) => a + b, 0) / paddingScores.length, weight: 0.50 });

  if (scores.length === 0) return { score: 1, issues: [] };
  const totalWeight = scores.reduce((s, x) => s + x.weight, 0);
  const score = scores.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;
  return { score, issues };
}

// ─── Main Differ ──────────────────────────────────────────────────────────────

/**
 * Diff a single matched pair.
 * For composite nodes, properties are sourced from their constituent source nodes.
 *
 * @param {object} figmaNode - from matchTrees().matched[i].figmaNode
 * @param {object} domNode   - from matchTrees().matched[i].domNode
 * @returns {object} diff result with per-bucket scores, issues, and overall score
 */
function diffPair(figmaNode, domNode) {
  // For composite nodes, pull the right source for each property type
  // sourceNodes[0] = container (has fill, borderRadius, layout)
  // sourceNodes[1+] = text nodes (have typography)
  const isComposite = figmaNode.type === 'composite';
  const figmaContainer = isComposite ? figmaNode.sourceNodes[0] : figmaNode;
  const figmaText      = isComposite ? figmaNode.sourceNodes.find(n => n.type === 'text') : figmaNode;

  const geometry   = diffGeometry(figmaNode, domNode);
  const typography = diffTypography(figmaText?.typography ?? null, domNode.typography);
  const color      = diffColor(figmaContainer, domNode);
  const spacing    = diffSpacing(figmaContainer.layout ?? null, domNode.layout ?? null);

  // Weighted overall score
  const overallScore =
    geometry.score   * BUCKET_WEIGHTS.geometry +
    typography.score * BUCKET_WEIGHTS.typography +
    color.score      * BUCKET_WEIGHTS.color +
    spacing.score    * BUCKET_WEIGHTS.spacing;

  // Collect all issues across buckets, sort by severity
  const severityOrder = { critical: 0, moderate: 1, minor: 2, info: 3 };
  const allIssues = [
    ...geometry.issues,
    ...typography.issues,
    ...color.issues,
    ...spacing.issues,
  ].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return {
    figmaId: figmaNode.id,
    domId: domNode.id,
    figmaName: figmaNode.name,
    domTag: domNode.domTag ?? null,
    matchedBy: null, // filled in by caller from match pair
    isComposite,

    scores: {
      overall: +overallScore.toFixed(4),
      geometry: +geometry.score.toFixed(4),
      typography: +(typography.skipped ? null : typography.score.toFixed(4)),
      color: +color.score.toFixed(4),
      spacing: +(spacing.skipped ? null : spacing.score.toFixed(4)),
    },

    issues: allIssues,
    issueCount: allIssues.filter(i => i.severity !== 'info').length,
  };
}

/**
 * Diff all matched pairs from matchTrees() output.
 *
 * @param {Array} matched - matchTrees().matched
 * @returns {Array} array of diff results, sorted by overall score ascending (worst first)
 */
function diffAll(matched) {
  const results = matched.map(pair => {
    const result = diffPair(pair.figmaNode, pair.domNode);
    result.matchedBy = pair.matchedBy;
    return result;
  });

  // Sort worst-first so the report surfaces real problems at the top
  results.sort((a, b) => a.scores.overall - b.scores.overall);
  return results;
}

module.exports = { diffAll, diffPair };