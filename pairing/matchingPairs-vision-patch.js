/**
 * matchingPairs-vision-patch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in wrapper around the original matchTrees() that adds a 3rd pass:
 * vision-assisted matching for nodes that couldn't be paired by IoU or text-anchor.
 *
 * HOW TO INTEGRATE:
 *   Replace this line in server.js:
 *     const { matchTrees } = require("./pairing/matchingPairs");
 *   With:
 *     const { matchTrees } = require("./pairing/matchingPairs-vision-patch");
 *
 * The exported API is 100% backward compatible — same inputs, same output shape,
 * with an added `vision` count in stats.byMethod.
 *
 * Vision pass is skipped if:
 *   - No screenshots are provided
 *   - GROQ_API_KEY is not set
 *   - The node has text (text nodes should have been caught by text-anchor)
 */

'use strict';

const { matchTrees: originalMatchTrees } = require('./matchingPairs');
const { visionAssistedMatch }            = require('./visual-diff');

/**
 * Extended matchTrees with optional vision-assisted 3rd pass.
 *
 * @param {Array}  figmaNodes   - normalized Figma nodes
 * @param {Array}  domNodes     - normalized DOM nodes
 * @param {object} [options]
 * @param {Buffer|string} [options.figmaScreenshot]  - Figma frame PNG (enables vision pass)
 * @param {Buffer|string} [options.domScreenshot]    - Website screenshot PNG
 * @param {number} [options.visionConfidence=0.7]    - Minimum confidence to accept vision match
 *
 * @returns {Promise<{ matched, unmatchedFigma, unmatchedDom, wrapperIds, stats }>}
 */
async function matchTrees(figmaNodes, domNodes, options = {}) {
  const {
    figmaScreenshot   = null,
    domScreenshot     = null,
    visionConfidence  = 0.7,
  } = options;

  // Pass 1 + 2: Original IoU + text-anchor matching (synchronous)
  const baseResult = originalMatchTrees(figmaNodes, domNodes);

  // Pass 3: Vision-assisted matching (async, only if screenshots provided)
  let visionMatches = [];

  if (figmaScreenshot && domScreenshot) {
    const hasApiKey = !!process.env.GROQ_API_KEY;

    if (!hasApiKey) {
      console.warn('[matchTrees] GROQ_API_KEY not set — skipping vision pass');
    } else {
      console.log(`[matchTrees] Vision pass: ${baseResult.unmatchedFigma.length} unmatched Figma, ${baseResult.unmatchedDom.length} unmatched DOM`);

      try {
        visionMatches = await visionAssistedMatch(
          baseResult.unmatchedFigma,
          baseResult.unmatchedDom,
          figmaScreenshot,
          domScreenshot,
          { confidenceThreshold: visionConfidence }
        );

        console.log(`[matchTrees] Vision pass found ${visionMatches.length} new matches`);
      } catch (err) {
        console.error('[matchTrees] Vision pass failed:', err.message);
      }
    }
  }

  // Merge vision matches into result
  const visionMatchedFigmaIds = new Set(visionMatches.map(m => m.figmaNode.id));
  const visionMatchedDomIds   = new Set(visionMatches.map(m => m.domNode.id));

  const allMatched = [
    ...baseResult.matched,
    ...visionMatches,
  ];

  const finalUnmatchedFigma = baseResult.unmatchedFigma.filter(n => !visionMatchedFigmaIds.has(n.id));
  const finalUnmatchedDom   = baseResult.unmatchedDom.filter(n => !visionMatchedDomIds.has(n.id));

  const stats = {
    ...baseResult.stats,
    matchedCount:       allMatched.length,
    unmatchedFigmaCount: finalUnmatchedFigma.length,
    unmatchedDomCount:   finalUnmatchedDom.length,
    averageScore: allMatched.length
      ? +(allMatched.reduce((s, m) => s + m.score, 0) / allMatched.length).toFixed(4)
      : 0,
    byMethod: {
      ...baseResult.stats.byMethod,
      vision: visionMatches.length,
    },
  };

  return {
    matched:        allMatched,
    unmatchedFigma: finalUnmatchedFigma,
    unmatchedDom:   finalUnmatchedDom,
    wrapperIds:     baseResult.wrapperIds,
    stats,
  };
}

module.exports = { matchTrees };