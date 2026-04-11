/**
 * Tree Matcher v2
 * Section-relative matching to handle coordinate drift between
 * Figma canvas space and browser-rendered DOM space.
 *
 * Strategy:
 *   1. Match top-level sections (depth=1) first using IoU
 *   2. For each matched section pair, compute the x/y offset between them
 *   3. Shift Figma child coordinates into DOM section space before matching
 *   4. Run greedy matching within each section independently
 */

const WEIGHTS = {
  iou: 0.55,
  type: 0.20,
  text: 0.15,
  depth: 0.10,
};

const MIN_IOU_THRESHOLD = 0.25; // slightly lower to handle real-world drift
const MIN_MATCH_SCORE = 0.30;
const BUCKET_SIZE = 200;

// ─── Geometry ────────────────────────────────────────────────────────────────

function computeIoU(a, b) {
  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(a.x + a.w, b.x + b.w);
  const interY2 = Math.min(a.y + a.h, b.y + b.h);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const intersection = interW * interH;
  if (intersection === 0) return 0;

  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - intersection;

  return union === 0 ? 0 : intersection / union;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function typeScore(a, b) {
  if (a.type === b.type) return 1;
  if (
    (a.type === 'text' && b.type === 'container') ||
    (a.type === 'container' && b.type === 'text')
  ) return 0.4;
  if (
    (a.type === 'icon' && b.type === 'image') ||
    (a.type === 'image' && b.type === 'icon')
  ) return 0.5;
  return 0;
}

function textSimilarity(a, b) {
  const tA = (a.text ?? '').trim().toLowerCase();
  const tB = (b.text ?? '').trim().toLowerCase();

  if (!tA && !tB) return 1;
  if (!tA || !tB) return 0;
  if (tA === tB) return 1;

  const wordsA = new Set(tA.split(/\s+/));
  const wordsB = new Set(tB.split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function depthScore(a, b) {
  const diff = Math.abs((a.depth ?? 0) - (b.depth ?? 0));
  return Math.max(0, 1 - diff * 0.25);
}

function computeMatchScore(figmaNode, domNode) {
  const iou = computeIoU(figmaNode, domNode);
  if (iou < MIN_IOU_THRESHOLD) return null;

  const score =
    iou                                * WEIGHTS.iou +
    typeScore(figmaNode, domNode)      * WEIGHTS.type +
    textSimilarity(figmaNode, domNode) * WEIGHTS.text +
    depthScore(figmaNode, domNode)     * WEIGHTS.depth;

  return { iou, score };
}

// ─── Spatial Bucketing ───────────────────────────────────────────────────────

function getBucketKeys(node) {
  const x1 = Math.floor(node.x / BUCKET_SIZE);
  const y1 = Math.floor(node.y / BUCKET_SIZE);
  const x2 = Math.floor((node.x + node.w) / BUCKET_SIZE);
  const y2 = Math.floor((node.y + node.h) / BUCKET_SIZE);

  const keys = [];
  for (let x = x1; x <= x2; x++) {
    for (let y = y1; y <= y2; y++) {
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

function buildSpatialIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    for (const key of getBucketKeys(node)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(node);
    }
  }
  return index;
}

function getCandidates(figmaNode, domIndex) {
  const seen = new Set();
  const candidates = [];
  for (const key of getBucketKeys(figmaNode)) {
    for (const domNode of (domIndex.get(key) ?? [])) {
      if (!seen.has(domNode.id)) {
        seen.add(domNode.id);
        candidates.push(domNode);
      }
    }
  }
  return candidates;
}

// ─── Core Greedy Matcher ─────────────────────────────────────────────────────

function greedyMatch(figmaNodes, domNodes) {
  if (figmaNodes.length === 0 || domNodes.length === 0) {
    return { matched: [], unmatchedFigma: figmaNodes, unmatchedDom: domNodes };
  }

  const domIndex = buildSpatialIndex(domNodes);
  const allPairs = [];

  for (const figmaNode of figmaNodes) {
    const candidates = getCandidates(figmaNode, domIndex);
    for (const domNode of candidates) {
      const result = computeMatchScore(figmaNode, domNode);
      if (result && result.score >= MIN_MATCH_SCORE) {
        allPairs.push({ figmaNode, domNode, ...result });
      }
    }
  }

  allPairs.sort((a, b) => b.score - a.score);

  const matchedFigma = new Set();
  const matchedDom = new Set();
  const matched = [];

  for (const pair of allPairs) {
    if (matchedFigma.has(pair.figmaNode.id)) continue;
    if (matchedDom.has(pair.domNode.id)) continue;
    matched.push(pair);
    matchedFigma.add(pair.figmaNode.id);
    matchedDom.add(pair.domNode.id);
  }

  return {
    matched,
    unmatchedFigma: figmaNodes.filter(n => !matchedFigma.has(n.id)),
    unmatchedDom: domNodes.filter(n => !matchedDom.has(n.id)),
  };
}

// Returns a copy of a node shifted by dx, dy
function shiftNode(node, dx, dy) {
  return { ...node, x: node.x + dx, y: node.y + dy };
}

// ─── Global Offset Matching ───────────────────────────────────────────────────
// Used when Figma frames are viewport-sized (full page frames) rather than
// semantic sections. Instead of section-by-section anchoring, we compute one
// global dx/dy offset by finding the best-matching anchor pair between the
// two trees, then shift all Figma nodes by that offset before matching.

function findGlobalOffset(figmaNodes, domNodes) {
  // Use the first meaningful Figma content node (not the root frame itself)
  // and find its best DOM match to derive the global offset.
  // We try the top-5 highest-IoU raw pairs across small nodes (more precise anchors).
  const figmaCandidates = figmaNodes.filter(n => n.depth >= 1 && n.w < 1440);
  const domCandidates   = domNodes.filter(n => n.depth >= 1 && n.w < 1440);

  const domIndex = buildSpatialIndex(domCandidates);
  const pairs = [];

  for (const fn of figmaCandidates) {
    for (const dn of getCandidates(fn, domIndex)) {
      const iou = computeIoU(fn, dn);
      if (iou > 0.1) {
        pairs.push({
          dx: dn.x - fn.x,
          dy: dn.y - fn.y,
          iou,
          textMatch: fn.text && dn.text && fn.text.trim() === dn.text.trim() ? 1 : 0,
        });
      }
    }
  }

  if (pairs.length === 0) return { dx: 0, dy: 0 };

  // Sort by text match first (strongest signal), then iou
  pairs.sort((a, b) => b.textMatch - a.textMatch || b.iou - a.iou);

  // Use the median of top-5 offsets to avoid outliers
  const top = pairs.slice(0, 5);
  const medianDx = top.map(p => p.dx).sort((a, b) => a - b)[Math.floor(top.length / 2)];
  const medianDy = top.map(p => p.dy).sort((a, b) => a - b)[Math.floor(top.length / 2)];

  console.log(`Global offset computed: dx:${medianDx} dy:${medianDy} (from ${top.length} anchor pairs)`);
  return { dx: medianDx, dy: medianDy };
}

function matchBySection(figmaNodes, domNodes) {
  // Detect if Figma is using viewport-sized frames (w===1440 and h>800 at depth 1)
  // If so, skip section anchoring and use global offset matching instead
  const figmaSections = figmaNodes.filter(n => n.depth === 1 && n.type === 'container');
  const isViewportFrameDesign = figmaSections.length > 0 &&
    figmaSections.every(n => n.w >= 1400 && n.h >= 800);

  if (isViewportFrameDesign) {
    return matchWithGlobalOffset(figmaNodes, domNodes);
  }

  // Otherwise use section-relative matching (original strategy)
  return matchBySectionRelative(figmaNodes, domNodes);
}

function matchWithGlobalOffset(figmaNodes, domNodes) {
  // Step 1 — compute a single global offset to align coordinate spaces
  const { dx, dy } = findGlobalOffset(figmaNodes, domNodes);

  // Step 2 — shift all figma nodes by the global offset
  const shiftedFigmaNodes = figmaNodes.map(n => shiftNode(n, dx, dy));

  // Step 3 — run a single greedy match pass in the aligned space
  const { matched: rawMatched, unmatchedFigma: rawUnmatchedFigma, unmatchedDom } =
    greedyMatch(shiftedFigmaNodes, domNodes);

  // Step 4 — restore original (unshifted) figma nodes in results
  const idToOriginal = new Map(figmaNodes.map(n => [n.id, n]));
  const matched = rawMatched.map(pair => ({
    ...pair,
    figmaNode: idToOriginal.get(pair.figmaNode.id),
  }));
  const unmatchedFigma = rawUnmatchedFigma.map(n => idToOriginal.get(n.id));

  return { matched, unmatchedFigma, unmatchedDom };
}

function matchBySectionRelative(figmaNodes, domNodes) {
  const usedFigmaIds = new Set();
  const usedDomIds = new Set();
  const allMatched = [];

  const figmaSections = figmaNodes.filter(n => n.depth === 1 && n.type === 'container');
  const domSections   = domNodes.filter(n => n.depth === 1 && n.type === 'container');
  const { matched: sectionPairs } = greedyMatch(figmaSections, domSections);

  for (const pair of sectionPairs) {
    allMatched.push(pair);
    usedFigmaIds.add(pair.figmaNode.id);
    usedDomIds.add(pair.domNode.id);

    const figmaChildren = figmaNodes.filter(n =>
      !usedFigmaIds.has(n.id) &&
      n.x >= pair.figmaNode.x - 1 && n.y >= pair.figmaNode.y - 1 &&
      n.x + n.w <= pair.figmaNode.x + pair.figmaNode.w + 1 &&
      n.y + n.h <= pair.figmaNode.y + pair.figmaNode.h + 1
    );
    const domChildren = domNodes.filter(n =>
      !usedDomIds.has(n.id) &&
      n.x >= pair.domNode.x - 1 && n.y >= pair.domNode.y - 1 &&
      n.x + n.w <= pair.domNode.x + pair.domNode.w + 1 &&
      n.y + n.h <= pair.domNode.y + pair.domNode.h + 1
    );

    if (figmaChildren.length === 0 || domChildren.length === 0) continue;

    const dx = pair.domNode.x - pair.figmaNode.x;
    const dy = pair.domNode.y - pair.figmaNode.y;
    const shifted = figmaChildren.map(n => shiftNode(n, dx, dy));
    const { matched: childMatches } = greedyMatch(shifted, domChildren);

    for (const childPair of childMatches) {
      const original = figmaChildren.find(n => n.id === childPair.figmaNode.id);
      allMatched.push({ ...childPair, figmaNode: original });
      usedFigmaIds.add(original.id);
      usedDomIds.add(childPair.domNode.id);
    }
  }

  const remainingFigma = figmaNodes.filter(n => !usedFigmaIds.has(n.id));
  const remainingDom   = domNodes.filter(n => !usedDomIds.has(n.id));
  const { matched: leftovers } = greedyMatch(remainingFigma, remainingDom);
  for (const pair of leftovers) {
    allMatched.push(pair);
    usedFigmaIds.add(pair.figmaNode.id);
    usedDomIds.add(pair.domNode.id);
  }

  return {
    matched: allMatched,
    unmatchedFigma: figmaNodes.filter(n => !usedFigmaIds.has(n.id)),
    unmatchedDom: domNodes.filter(n => !usedDomIds.has(n.id)),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Match normalized Figma nodes against normalized DOM nodes.
 *
 * @param {Array} figmaNodes - output of normalizeFigmaFrame().nodes
 * @param {Array} domNodes   - output of normalizeDomTree().nodes
 * @returns {{ matched, unmatchedFigma, unmatchedDom, stats }}
 */
function matchTrees(figmaNodes, domNodes) {
  const { matched, unmatchedFigma, unmatchedDom } = matchBySection(figmaNodes, domNodes);

  const stats = {
    figmaTotal: figmaNodes.length,
    domTotal: domNodes.length,
    matchedCount: matched.length,
    unmatchedFigmaCount: unmatchedFigma.length,
    unmatchedDomCount: unmatchedDom.length,
    averageScore: matched.length > 0
      ? +(matched.reduce((s, m) => s + m.score, 0) / matched.length).toFixed(4)
      : 0,
    averageIoU: matched.length > 0
      ? +(matched.reduce((s, m) => s + m.iou, 0) / matched.length).toFixed(4)
      : 0,
  };

  return { matched, unmatchedFigma, unmatchedDom, stats };
}

module.exports = { matchTrees, computeIoU, computeMatchScore };