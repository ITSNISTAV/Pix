/**
 * scoreAggregator.js  (updated — visual layer support)
 * ─────────────────────────────────────────────────────────────────────────────
 * Changes from original:
 *   - aggregate() now accepts an optional `visualScores` map (nodeId → visualScore data)
 *   - Per-node scores are fused (semantic + visual) when visual data is available
 *   - Report gains a `visualDrift` section with per-node visual breakdowns
 *   - fuseScores() imported from visual-diff.js — no logic duplicated here
 *
 * All original behaviour is unchanged when visualScores is not passed.
 */

'use strict';

const { fuseScores } = require('../visual/visual-diff');

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
  const valid = pairs.filter(p => p.value != null);
  if (!valid.length) return null;
  const totalWeight = valid.reduce((s, p) => s + p.weight, 0);
  return valid.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
}

// ─── Coverage Score ───────────────────────────────────────────────────────────

function computeCoverageScore(totalFigmaNodes, matchedCount, wrapperCount = 0) {
  const matchable = totalFigmaNodes - wrapperCount;
  if (matchable <= 0) return 1;
  return Math.min(1, matchedCount / matchable);
}

// ─── Bucket Aggregation ───────────────────────────────────────────────────────

function aggregateBuckets(diffs) {
  return {
    geometry:   avg(diffs.map(d => d.scores.geometry)),
    typography: avg(diffs.map(d => d.scores.typography).filter(v => v != null)),
    color:      avg(diffs.map(d => d.scores.color)),
    spacing:    avg(diffs.map(d => d.scores.spacing).filter(v => v != null)),
  };
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

  const byProperty = {};
  for (const issue of all) {
    if (!byProperty[issue.property]) byProperty[issue.property] = [];
    byProperty[issue.property].push(issue);
  }

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
    .sort((a, b) => (a.scores.finalScore ?? a.scores.overall) - (b.scores.finalScore ?? b.scores.overall))
    .slice(0, topN)
    .map(d => ({
      figmaName: d.figmaName,
      domTag: d.domTag,
      overallScore:  d.scores.overall,
      finalScore:    d.scores.finalScore ?? d.scores.overall,
      visualScore:   d.scores.visualScore ?? null,
      pixelChangePct: d.pixelChangePct ?? null,
      issueCount: d.issueCount,
      topIssue: d.issues.find(i => i.severity === 'critical') ??
                d.issues.find(i => i.severity === 'moderate') ??
                d.issues[0],
    }));
}

// ─── Visual Drift Section ─────────────────────────────────────────────────────

/**
 * Build the visualDrift section of the report.
 * Nodes are bucketed by how much their visual (pixel) score deviates.
 */
function buildVisualDriftReport(diffs) {
  const withVisual = diffs.filter(d => d.scores.visualScore != null);

  if (!withVisual.length) {
    return { available: false, message: 'No visual scores computed — screenshots not provided' };
  }

  const avgVisualScore = avg(withVisual.map(d => d.scores.visualScore));
  const avgPixelChange = avg(withVisual.map(d => d.pixelChangePct ?? 0));

  // Bucket nodes by visual drift severity
  // <5% diff = clean, 5-20% = minor drift, 20-50% = moderate drift, >50% = severe
  const clean    = withVisual.filter(d => (d.pixelChangePct ?? 0) < 0.05);
  const minor    = withVisual.filter(d => (d.pixelChangePct ?? 0) >= 0.05 && (d.pixelChangePct ?? 0) < 0.20);
  const moderate = withVisual.filter(d => (d.pixelChangePct ?? 0) >= 0.20 && (d.pixelChangePct ?? 0) < 0.50);
  const severe   = withVisual.filter(d => (d.pixelChangePct ?? 0) >= 0.50);

  // Nodes where visual score disagrees significantly with semantic score
  // (semantic says OK but visual is bad — likely rendering issues JSON can't catch)
  const hiddenIssues = withVisual.filter(d =>
    d.scores.overall >= 0.80 &&
    (d.pixelChangePct ?? 0) > 0.25
  );

  return {
    available: true,
    summary: {
      nodesScored:       withVisual.length,
      avgVisualScore:    avgVisualScore != null ? +avgVisualScore.toFixed(4) : null,
      avgPixelChangePct: avgPixelChange != null ? +(avgPixelChange * 100).toFixed(2) : null,
    },
    buckets: {
      clean:    { count: clean.length,    nodes: clean.map(d => d.figmaName) },
      minor:    { count: minor.length,    nodes: minor.map(d => d.figmaName) },
      moderate: { count: moderate.length, nodes: moderate.map(d => d.figmaName) },
      severe:   { count: severe.length,   nodes: severe.map(d => d.figmaName) },
    },
    hiddenIssues: hiddenIssues.map(d => {
      // Distinguish image-content mismatch from rendering artifact
      const isImageNode = d.domTag === 'img' || d.domTag === 'picture' ||
        d.figmaName?.match(/\.(jpg|png|webp|jpeg|gif|1)\s*$/i) ||
        (d.figmaName?.toLowerCase().includes('-') && d.pixelChangePct > 0.50);

      const note = isImageNode
        ? 'Image content differs — the actual photo/asset shown in the browser does not match the Figma design'
        : 'Semantic score is good but pixel diff is high — possible rendering artifact, font rendering, or shadow mismatch';

      return {
        figmaName:      d.figmaName,
        domTag:         d.domTag,
        semanticScore:  d.scores.overall,
        visualScore:    d.scores.visualScore,
        pixelChangePct: +(d.pixelChangePct * 100).toFixed(2),
        note,
      };
    }),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Aggregate diff results into a full fidelity report.
 *
 * @param {Array}  diffs          - output of diffAll()
 * @param {object} matchStats     - output of matchTrees().stats
 * @param {number} wrapperCount   - matchTrees().wrapperIds.size
 * @param {object} [visualData]   - optional visual scores from computeVisualScores()
 *                                  Shape: { [figmaId]: { visualScore, pixelChangePct } }
 *                                  Pass null/undefined to skip visual fusion.
 * @returns {object} fidelity report
 */
function aggregate(diffs, matchStats, wrapperCount = 0, visualData = null) {
  if (!diffs.length) {
    return { error: 'No diffs to aggregate' };
  }

  // ── Fuse visual scores into diff objects (if available) ───────────────────
  const enrichedDiffs = diffs.map(d => {
    const vd = visualData?.[d.figmaId];

    if (!vd) {
      // No visual data for this node — keep semantic score as-is
      return {
        ...d,
        scores: { ...d.scores, visualScore: null, finalScore: d.scores.overall },
        pixelChangePct: null,
      };
    }

    const finalScore = fuseScores(d.scores.overall, vd.visualScore, vd.pixelChangePct);

    return {
      ...d,
      scores: {
        ...d.scores,
        visualScore: vd.visualScore,
        finalScore,
      },
      pixelChangePct: vd.pixelChangePct,
    };
  });

  // 1 — Coverage
  const coverageScore = computeCoverageScore(
    matchStats.figmaTotal,
    matchStats.matchedCount,
    wrapperCount
  );

  // 2 — Matched node quality (using finalScore = fused score)
  const weightedDiffs = enrichedDiffs.map(d => ({
    value:  d.scores.finalScore ?? d.scores.overall,
    weight: d.matchedBy === 'iou' ? 1.0 : 0.85,
  }));
  const matchedQualityScore = weighted(weightedDiffs) ?? 0;

  // 3 — Page fidelity
  const pageFidelityScore = coverageScore * 0.30 + matchedQualityScore * 0.70;

  // 4 — Per-bucket breakdown
  const buckets = aggregateBuckets(enrichedDiffs);

  // 5 — Issue summary
  const issues = aggregateIssues(enrichedDiffs);

  // 6 — Worst offenders (ranked by finalScore)
  const worstOffenders = getWorstOffenders(enrichedDiffs);

  // 7 — Visual drift report
  const visualDrift = buildVisualDriftReport(enrichedDiffs);

  // 8 — Grade
  const gradeInfo = getGrade(pageFidelityScore);

  return {
    grade: gradeInfo.grade,
    label: gradeInfo.label,

    scores: {
      pageFidelity:   +pageFidelityScore.toFixed(4),
      coverage:       +coverageScore.toFixed(4),
      matchedQuality: +matchedQualityScore.toFixed(4),
      visualEnabled:  visualData !== null,
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
    visualDrift,

    // Raw data for AI reasoning — includes visual scores for richer prompts
    diffsForAI: enrichedDiffs
      .filter(d => d.issueCount > 0)
      .sort((a, b) => (a.scores.finalScore ?? a.scores.overall) - (b.scores.finalScore ?? b.scores.overall))
      .map(d => ({
        figmaName:      d.figmaName,
        domTag:         d.domTag,
        isComposite:    d.isComposite ?? false,
        overallScore:   d.scores.overall,
        visualScore:    d.scores.visualScore ?? null,
        finalScore:     d.scores.finalScore ?? d.scores.overall,
        pixelChangePct: d.pixelChangePct != null ? +(d.pixelChangePct * 100).toFixed(1) : null,
        issues: d.issues.filter(i => i.severity !== 'info'),
      })),
  };
}

module.exports = { aggregate };