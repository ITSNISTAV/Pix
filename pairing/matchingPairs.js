/**
 * Tree Matcher v4
 *
 * Handles 4 real-world mapping patterns:
 *
 *   Pattern 1 — 1:1 (standard IoU match)
 *     Figma [text "para"] ↔ DOM [<p> "para"]
 *
 *   Pattern 2 — N:1 Composite (siblings collapse into one DOM node)
 *     Figma [rect fill:#f87700] + [text "Back"] ↔ DOM [<button> "Back" fill:#f87700]
 *     Pre-pass detects container+text sibling pairs and merges them before matching.
 *
 *   Pattern 3 — Wrapper (Figma grouping with no DOM equivalent)
 *     Figma [Group 1], [Group 2], [Group 3] → no DOM match → correctly unmatched
 *     These are design-only containers. We skip them rather than force bad matches.
 *
 *   Pattern 4 — Text-anchor (same text, x-aligned, y-drifted)
 *     Figma nav items at y:53 ↔ DOM <li> at y:20 — zero IoU but exact text + x-overlap
 *     Extended Y-bucket search catches these after IoU matching.
 */

const WEIGHTS = {
  iou: 0.50,
  type: 0.20,
  text: 0.20,
  depth: 0.10,
};

const MIN_IOU_THRESHOLD = 0.10;
const MIN_MATCH_SCORE = 0.30;
const BUCKET_SIZE = 200;

// ─── Geometry ────────────────────────────────────────────────────────────────

function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!inter) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function computeXOverlap(a, b) {
  const inter = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const union = Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x);
  return union ? inter / union : 0;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function typeScore(a, b) {
  if (a.type === b.type) return 1;
  // composite type matches both container and text aspects
  if (a.type === 'composite') return 0.9;
  if ((a.type === 'text' && b.type === 'container') ||
      (a.type === 'container' && b.type === 'text')) return 0.4;
  if ((a.type === 'icon' && b.type === 'image') ||
      (a.type === 'image' && b.type === 'icon')) return 0.5;
  return 0;
}

function textSimilarity(a, b) {
  const tA = (a.text ?? '').trim().toLowerCase();
  const tB = (b.text ?? '').trim().toLowerCase();
  if (!tA && !tB) return 1;
  if (!tA || !tB) return 0;
  if (tA === tB) return 1;
  const wA = new Set(tA.split(/\s+/));
  const wB = new Set(tB.split(/\s+/));
  const inter = [...wA].filter(w => wB.has(w)).length;
  return inter / new Set([...wA, ...wB]).size;
}

function depthScore(a, b) {
  return Math.max(0, 1 - Math.abs((a.depth ?? 0) - (b.depth ?? 0)) * 0.25);
}

function computeMatchScore(figmaNode, domNode) {
  const iou = computeIoU(figmaNode, domNode);

  // Standard IoU path
  if (iou >= MIN_IOU_THRESHOLD) {
    const score =
      iou                                * WEIGHTS.iou +
      typeScore(figmaNode, domNode)      * WEIGHTS.type +
      textSimilarity(figmaNode, domNode) * WEIGHTS.text +
      depthScore(figmaNode, domNode)     * WEIGHTS.depth;
    return { iou, score, matchedBy: 'iou' };
  }

  // Text-anchor path: exact text match + x-column alignment
  // Handles nav items and cake labels with y-drift too large for IoU
  const tA = (figmaNode.text ?? '').trim();
  const tB = (domNode.text ?? '').trim();
  if (tA && tB && tA.toLowerCase() === tB.toLowerCase()) {
    const xOverlap = computeXOverlap(figmaNode, domNode);
    if (xOverlap > 0.35) {
      const score =
        xOverlap * 0.35 +
        typeScore(figmaNode, domNode) * 0.30 +
        1.0                           * 0.25 +
        depthScore(figmaNode, domNode) * 0.10;
      return { iou, score, matchedBy: 'text-anchor' };
    }
  }

  return null;
}

// ─── Pattern 2: Composite Pre-pass ───────────────────────────────────────────
// Detects Figma sibling pairs where a filled container wraps a text node
// and collapses them into one composite node for matching.
// This handles: button+label, card+title, any filled-rect+text patterns.

function buildCompositeNodes(figmaNodes) {
  const absorbedIds = new Set();
  const composites = [];

  // Group nodes by parent
  const byParent = new Map();
  for (const n of figmaNodes) {
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
    byParent.get(n.parentId).push(n);
  }

  for (const siblings of byParent.values()) {
    const filledContainers = siblings.filter(n =>
      n.type === 'container' && n.fill?.hex && n.fill.hex !== '#ffffff'
    );
    const textNodes = siblings.filter(n => n.type === 'text' && n.text);

    for (const container of filledContainers) {
      // Find text siblings whose bounding box overlaps with this container
      const insideTexts = textNodes.filter(t =>
        !absorbedIds.has(t.id) &&
        t.x >= container.x - 2 && t.y >= container.y - 2 &&
        t.x + t.w <= container.x + container.w + 2 &&
        t.y + t.h <= container.y + container.h + 2
      );

      if (insideTexts.length === 0) continue;

      composites.push({
        id: `composite:${container.id}`,
        name: container.name,
        type: 'composite',
        // Use container's geometry — it defines the visual boundary
        x: container.x,
        y: container.y,
        w: container.w,
        h: container.h,
        // Merge text from all inside text nodes
        text: insideTexts.map(t => t.text).join(' '),
        fill: container.fill,
        borderRadius: container.borderRadius,
        opacity: container.opacity,
        // Typography from first text node
        typography: insideTexts[0].typography ?? null,
        depth: container.depth,
        parentId: container.parentId,
        source: 'figma',
        // Track which original nodes contributed so property differ can use both
        sourceIds: [container.id, ...insideTexts.map(t => t.id)],
        sourceNodes: [container, ...insideTexts],
      });

      absorbedIds.add(container.id);
      insideTexts.forEach(t => absorbedIds.add(t.id));
    }
  }

  // Pattern 3: Mark pure GROUP wrappers — Figma-only grouping nodes with no visual DOM equivalent
  // Only skip figmaType === GROUP nodes that are empty and have no matchable children
  // Do NOT skip FRAME or RECTANGLE — those represent real visual sections and images
  const wrapperIds = new Set();
  for (const n of figmaNodes) {
    if (absorbedIds.has(n.id)) continue;
    const isGroupType = n.figmaType === 'GROUP';
    const isEmptyContainer = n.type === 'container' && !n.text && !n.fill?.hex;
    const hasNoMatchableChildren = !figmaNodes.some(c =>
      c.parentId === n.id && (c.text || c.fill?.hex)
    );
    if (isGroupType && isEmptyContainer && hasNoMatchableChildren) {
      wrapperIds.add(n.id);
    }
  }

  const remaining = figmaNodes.filter(n =>
    !absorbedIds.has(n.id) && !wrapperIds.has(n.id)
  );

  return {
    nodes: [...composites, ...remaining],
    absorbedIds,
    wrapperIds,
  };
}

// ─── Spatial Bucketing ───────────────────────────────────────────────────────

function getBucketKeys(node, extended = false) {
  const x1 = Math.floor(node.x / BUCKET_SIZE);
  const y1 = Math.floor(node.y / BUCKET_SIZE) - (extended ? 1 : 0);
  const x2 = Math.floor((node.x + node.w) / BUCKET_SIZE);
  const y2 = Math.floor((node.y + node.h) / BUCKET_SIZE) + (extended ? 1 : 0);
  const keys = [];
  for (let x = x1; x <= x2; x++)
    for (let y = y1; y <= y2; y++)
      keys.push(`${x},${y}`);
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
  // Always use extended buckets — catches text-anchor matches across y-drift
  for (const key of getBucketKeys(figmaNode, true)) {
    for (const dn of (domIndex.get(key) ?? [])) {
      if (!seen.has(dn.id)) { seen.add(dn.id); candidates.push(dn); }
    }
  }
  return candidates;
}

// ─── Core Greedy Matcher ─────────────────────────────────────────────────────

function greedyMatch(figmaNodes, domNodes) {
  if (!figmaNodes.length || !domNodes.length)
    return { matched: [], unmatchedFigma: figmaNodes, unmatchedDom: domNodes };

  const domIndex = buildSpatialIndex(domNodes);
  const allPairs = [];

  for (const fn of figmaNodes) {
    for (const dn of getCandidates(fn, domIndex)) {
      const result = computeMatchScore(fn, dn);
      if (result && result.score >= MIN_MATCH_SCORE)
        allPairs.push({ figmaNode: fn, domNode: dn, ...result });
    }
  }

  // IoU matches take priority over text-anchor matches in tie-breaking
  allPairs.sort((a, b) =>
    a.matchedBy !== b.matchedBy
      ? (a.matchedBy === 'iou' ? -1 : 1)
      : b.score - a.score
  );

  const usedFigma = new Set(), usedDom = new Set();
  const matched = [];

  for (const pair of allPairs) {
    if (usedFigma.has(pair.figmaNode.id)) continue;
    if (usedDom.has(pair.domNode.id)) continue;
    matched.push(pair);
    usedFigma.add(pair.figmaNode.id);
    usedDom.add(pair.domNode.id);
  }

  return {
    matched,
    unmatchedFigma: figmaNodes.filter(n => !usedFigma.has(n.id)),
    unmatchedDom: domNodes.filter(n => !usedDom.has(n.id)),
  };
}

// ─── Global Offset Detection ──────────────────────────────────────────────────

function shiftNode(node, dx, dy) {
  return { ...node, x: node.x + dx, y: node.y + dy };
}

function findGlobalOffset(figmaNodes, domNodes) {
  const figmaCandidates = figmaNodes.filter(n => n.depth >= 1 && n.w < 1440);
  const domCandidates   = domNodes.filter(n => n.depth >= 1 && n.w < 1440);
  const domIndex = buildSpatialIndex(domCandidates);
  const pairs = [];

  for (const fn of figmaCandidates) {
    for (const dn of getCandidates(fn, domIndex)) {
      const iou = computeIoU(fn, dn);
      if (iou > 0.1) {
        pairs.push({
          dx: dn.x - fn.x, dy: dn.y - fn.y, iou,
          textMatch: fn.text && dn.text && fn.text.trim() === dn.text.trim() ? 1 : 0,
        });
      }
    }
  }

  if (!pairs.length) return { dx: 0, dy: 0 };

  pairs.sort((a, b) => b.textMatch - a.textMatch || b.iou - a.iou);
  const top = pairs.slice(0, 5);
  const medDx = top.map(p => p.dx).sort((a, b) => a - b)[Math.floor(top.length / 2)];
  const medDy = top.map(p => p.dy).sort((a, b) => a - b)[Math.floor(top.length / 2)];

  console.log(`Global offset: dx:${medDx} dy:${medDy} (from ${top.length} anchors)`);
  return { dx: medDx, dy: medDy };
}

// ─── Match Strategies ─────────────────────────────────────────────────────────

function matchWithGlobalOffset(figmaNodes, domNodes) {
  const { dx, dy } = findGlobalOffset(figmaNodes, domNodes);
  const idToOriginal = new Map(figmaNodes.map(n => [n.id, n]));

  // Pass 1 — IoU matching with global shift applied (handles containers, images, paragraphs)
  const shifted = figmaNodes.map(n => shiftNode(n, dx, dy));
  const { matched: raw, unmatchedFigma: rawUnmatched, unmatchedDom: rawUnmatchedDom } =
    greedyMatch(shifted, domNodes);

  const matched = raw.map(p => ({ ...p, figmaNode: idToOriginal.get(p.figmaNode.id) }));
  const usedDomIds = new Set(matched.map(p => p.domNode.id));

  // Pass 2 — text-anchor matching on UNSHIFTED originals for leftovers
  // Nav items and other text-only nodes have independent drift — the global shift hurts them
  const unmatchedOriginals = rawUnmatched.map(n => idToOriginal.get(n.id));
  const remainingDom = rawUnmatchedDom.filter(n => !usedDomIds.has(n.id));
  const { matched: textMatches } = greedyMatch(unmatchedOriginals, remainingDom);

  return {
    matched: [...matched, ...textMatches],
    unmatchedFigma: unmatchedOriginals.filter(n => !textMatches.some(m => m.figmaNode.id === n.id)),
    unmatchedDom: remainingDom.filter(n => !textMatches.some(m => m.domNode.id === n.id)),
  };
}

function matchBySectionRelative(figmaNodes, domNodes) {
  const usedFigmaIds = new Set(), usedDomIds = new Set();
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

    if (!figmaChildren.length || !domChildren.length) continue;

    const dx = pair.domNode.x - pair.figmaNode.x;
    const dy = pair.domNode.y - pair.figmaNode.y;
    const shifted = figmaChildren.map(n => shiftNode(n, dx, dy));
    const { matched: childMatches } = greedyMatch(shifted, domChildren);

    for (const cp of childMatches) {
      const original = figmaChildren.find(n => n.id === cp.figmaNode.id);
      allMatched.push({ ...cp, figmaNode: original });
      usedFigmaIds.add(original.id);
      usedDomIds.add(cp.domNode.id);
    }
  }

  const remainingFigma = figmaNodes.filter(n => !usedFigmaIds.has(n.id));
  const remainingDom   = domNodes.filter(n => !usedDomIds.has(n.id));
  const { matched: leftovers } = greedyMatch(remainingFigma, remainingDom);
  for (const p of leftovers) {
    allMatched.push(p);
    usedFigmaIds.add(p.figmaNode.id);
    usedDomIds.add(p.domNode.id);
  }

  return {
    matched: allMatched,
    unmatchedFigma: figmaNodes.filter(n => !usedFigmaIds.has(n.id)),
    unmatchedDom: domNodes.filter(n => !usedDomIds.has(n.id)),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {Array} figmaNodes - output of normalizeFigmaFrame().nodes
 * @param {Array} domNodes   - output of normalizeDomTree().nodes
 * @returns {{ matched, unmatchedFigma, unmatchedDom, wrapperIds, stats }}
 */
function matchTrees(figmaNodes, domNodes) {
  // Pre-pass: collapse composite patterns + mark pure wrappers
  const { nodes: processedFigma, absorbedIds, wrapperIds } = buildCompositeNodes(figmaNodes);

  // Choose match strategy based on Figma design structure
  const figmaSections = processedFigma.filter(n => n.depth === 1 && n.type === 'container');
  const isViewportFrameDesign = figmaSections.length > 0 &&
    figmaSections.every(n => n.w >= 1400 && n.h >= 800);

  const { matched, unmatchedFigma, unmatchedDom } = isViewportFrameDesign
    ? matchWithGlobalOffset(processedFigma, domNodes)
    : matchBySectionRelative(processedFigma, domNodes);

  const stats = {
    figmaTotal: figmaNodes.length,
    domTotal: domNodes.length,
    compositesBuilt: matched.filter(m => m.figmaNode.type === 'composite').length +
                     unmatchedFigma.filter(n => n.type === 'composite').length,
    wrappersSkipped: wrapperIds.size,
    matchedCount: matched.length,
    unmatchedFigmaCount: unmatchedFigma.length,
    unmatchedDomCount: unmatchedDom.length,
    averageScore: matched.length
      ? +(matched.reduce((s, m) => s + m.score, 0) / matched.length).toFixed(4)
      : 0,
    averageIoU: matched.length
      ? +(matched.reduce((s, m) => s + m.iou, 0) / matched.length).toFixed(4)
      : 0,
    byMethod: {
      iou: matched.filter(m => m.matchedBy === 'iou').length,
      textAnchor: matched.filter(m => m.matchedBy === 'text-anchor').length,
    },
  };

  return { matched, unmatchedFigma, unmatchedDom, wrapperIds, stats };
}

module.exports = { matchTrees, computeIoU, computeMatchScore };