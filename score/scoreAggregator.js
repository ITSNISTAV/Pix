/**
 * Score Aggregator
 * Rolls up per-node diff results into three levels:
 *   1. Page-level   — single overall fidelity score + grade
 *   2. Bucket-level — per-category breakdown (geometry, typography, color, spacing)
 *   3. Issue report — prioritized list of problems for the AI reasoning layer
 *
 * Also tracks unmatched nodes as a coverage penalty —
 * a page where 30% of Figma nodes have no DOM equivalent
 * can't honestly score above 70% fidelity.
 */

// ─── Grade Thresholds ─────────────────────────────────────────────────────────

const GRADES = [
  { min: 0.95, grade: 'A', label: 'Excellent — nearly pixel-perfect' },
  { min: 0.85, grade: 'B', label: 'Good — minor drift, easily fixable' },
  { min: 0.70, grade: 'C', label: 'Fair — noticeable issues in multiple areas' },
  { min: 0.55, grade: 'D', label: 'Poor — significant design drift' },
  { min: 0.00, grade: 'F', label: 'Critical — implementation diverges from design' },
];

function getGrade(score) {
  return GRADES.find(g => score >= g.min) ?? GRADES[GRADES.length - 1];
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

function avg(arr) {
  const valid = arr.filter(v => v != null && !isNaN(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function weighted(pairs) {
  // pairs: [{ value, weight }]
  const valid = pairs.filter(p => p.value != null);
  if (!valid.length) return null;
  const totalWeight = valid.reduce((s, p) => s + p.weight, 0);
  return valid.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
}

// ─── Coverage Score ───────────────────────────────────────────────────────────
// Penalizes the overall score for Figma nodes that have no DOM match.
// Wrappers (design-only groups) are excluded — they're intentionally unmatched.

function computeCoverageScore(totalFigmaNodes, matchedCount, wrapperCount = 0) {
  const matchable = totalFigmaNodes - wrapperCount;
  if (matchable <= 0) return 1;
  return Math.min(1, matchedCount / matchable);
}

// ─── Bucket Aggregation ───────────────────────────────────────────────────────

function aggregateBuckets(diffs) {
  const geometry   = avg(diffs.map(d => d.scores.geometry));
  const typography = avg(diffs.map(d => d.scores.typography).filter(v => v != null));
  const color      = avg(diffs.map(d => d.scores.color));
  const spacing    = avg(diffs.map(d => d.scores.spacing).filter(v => v != null));

  return { geometry, typography, color, spacing };
}

// ─── Issue Summary ────────────────────────────────────────────────────────────

function aggregateIssues(diffs) {
  const all = diffs.flatMap(d =>
    (d.issues ?? [])
      .filter(i => i.severity !== 'info')
      .map(i => ({ ...i, figmaName: d.figmaName, domTag: d.domTag }))
  );

  const bySeverity = {
    critical: all.filter(i => i.severity === 'critical'),
    moderate: all.filter(i => i.severity === 'moderate'),
    minor:    all.filter(i => i.severity === 'minor'),
  };

  // Group by property type to find systemic issues
  // e.g. "fontSize wrong on 6 nodes" is more important than "fontSize wrong on 1"
  const byProperty = {};
  for (const issue of all) {
    if (!byProperty[issue.property]) byProperty[issue.property] = [];
    byProperty[issue.property].push(issue);
  }

  // Systemic issues = same property failing on 3+ nodes
  const systemic = Object.entries(byProperty)
    .filter(([, issues]) => issues.length >= 3)
    .map(([property, issues]) => ({
      property,
      count: issues.length,
      severity: issues[0].severity,
      affectedNodes: issues.map(i => i.figmaName),
    }))
    .sort((a, b) => b.count - a.count);

  return { bySeverity, byProperty, systemic, total: all.length };
}

// ─── Worst Offenders ─────────────────────────────────────────────────────────

function getWorstOffenders(diffs, topN = 5) {
  return [...diffs]
    .filter(d => d.issueCount > 0)
    .sort((a, b) => a.scores.overall - b.scores.overall)
    .slice(0, topN)
    .map(d => ({
      figmaName: d.figmaName,
      domTag: d.domTag,
      overallScore: d.scores.overall,
      issueCount: d.issueCount,
      topIssue: d.issues.find(i => i.severity === 'critical') ??
                d.issues.find(i => i.severity === 'moderate') ??
                d.issues[0],
    }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Aggregate diff results into a full fidelity report.
 *
 * @param {Array}  diffs          - output of diffAll()
 * @param {object} matchStats     - output of matchTrees().stats
 * @param {number} wrapperCount   - matchTrees().wrapperIds.size
 * @returns {object} fidelity report
 */
function aggregate(diffs, matchStats, wrapperCount = 0) {
  if (!diffs.length) {
    return { error: 'No diffs to aggregate' };
  }

  // 1 — Coverage: how many Figma nodes made it to a DOM match
  const coverageScore = computeCoverageScore(
    matchStats.figmaTotal,
    matchStats.matchedCount,
    wrapperCount
  );

  // 2 — Matched node quality: weighted average of per-node overall scores
  //     Nodes matched by IoU get full weight.
  //     Nodes matched by text-anchor get 0.85 weight (less spatial confidence).
  const weightedDiffs = diffs.map(d => ({
    value: d.scores.overall,
    weight: d.matchedBy === 'iou' ? 1.0 : 0.85,
  }));
  const matchedQualityScore = weighted(weightedDiffs) ?? 0;

  // 3 — Page fidelity: blend coverage and quality
  //     Coverage is 30% of the score — missing elements matter
  //     Matched quality is 70% — property accuracy matters more
  const pageFidelityScore = coverageScore * 0.30 + matchedQualityScore * 0.70;

  // 4 — Per-bucket breakdown
  const buckets = aggregateBuckets(diffs);

  // 5 — Issue summary
  const issues = aggregateIssues(diffs);

  // 6 — Worst offenders
  const worstOffenders = getWorstOffenders(diffs);

  // 7 — Grade
  const gradeInfo = getGrade(pageFidelityScore);

  return {
    grade: gradeInfo.grade,
    label: gradeInfo.label,

    scores: {
      pageFidelity:    +pageFidelityScore.toFixed(4),
      coverage:        +coverageScore.toFixed(4),
      matchedQuality:  +matchedQualityScore.toFixed(4),
      byBucket: {
        geometry:   buckets.geometry   != null ? +buckets.geometry.toFixed(4)   : null,
        typography: buckets.typography != null ? +buckets.typography.toFixed(4) : null,
        color:      buckets.color      != null ? +buckets.color.toFixed(4)      : null,
        spacing:    buckets.spacing    != null ? +buckets.spacing.toFixed(4)    : null,
      },
    },

    coverage: {
      figmaTotal:      matchStats.figmaTotal,
      domTotal:        matchStats.domTotal,
      matched:         matchStats.matchedCount,
      unmatchedFigma:  matchStats.unmatchedFigmaCount,
      unmatchedDom:    matchStats.unmatchedDomCount,
      wrappersSkipped: wrapperCount,
      coveragePct:     +(coverageScore * 100).toFixed(1),
    },

    issues: {
      total:    issues.total,
      critical: issues.bySeverity.critical.length,
      moderate: issues.bySeverity.moderate.length,
      minor:    issues.bySeverity.minor.length,
      systemic: issues.systemic,
    },

    worstOffenders,

    // Raw data for the AI reasoning layer (Step 6)
    // Includes every diff with issues, sorted worst-first
    diffsForAI: diffs
      .filter(d => d.issueCount > 0)
      .sort((a, b) => a.scores.overall - b.scores.overall)
      .map(d => ({
        figmaName: d.figmaName,
        domTag: d.domTag,
        isComposite: d.isComposite ?? false,
        overallScore: d.scores.overall,
        issues: d.issues.filter(i => i.severity !== 'info'),
      })),
  };
}

module.exports = { aggregate };