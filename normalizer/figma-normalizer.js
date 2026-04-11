/**
 * Figma Normalizer
 * Converts raw Figma API JSON into a normalized node list
 * with frame-relative coordinates.
 */

// Figma node types we care about — everything else is structural noise
const RELEVANT_TYPES = new Set([
  'FRAME', 'COMPONENT', 'INSTANCE', 'GROUP',
  'TEXT', 'RECTANGLE', 'VECTOR', 'ELLIPSE', 'IMAGE'
]);

// Map Figma types to our common semantic types
function toSemanticType(figmaType, node) {
  if (figmaType === 'TEXT') return 'text';
  if (figmaType === 'IMAGE') return 'image';
  if (figmaType === 'VECTOR' || figmaType === 'ELLIPSE') return 'icon';
  if (['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'RECTANGLE'].includes(figmaType)) return 'container';
  return 'unknown';
}

// Extract color from a Figma fill object → hex string
function figmaColorToHex(color) {
  if (!color) return null;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Get the primary fill color from a fills array
function extractFillColor(fills) {
  if (!fills || fills.length === 0) return null;
  const solidFill = fills.find(f => f.type === 'SOLID' && f.visible !== false);
  if (!solidFill) return null;
  const hex = figmaColorToHex(solidFill.color);
  const opacity = solidFill.opacity ?? 1;
  return { hex, opacity };
}

// Extract typography styles from a TEXT node
function extractTypography(node) {
  const style = node.style;
  if (!style) return null;
  return {
    fontFamily: style.fontFamily ?? null,
    fontSize: style.fontSize ?? null,
    fontWeight: style.fontWeight ?? null,
    lineHeight: style.lineHeightPx ?? null,
    letterSpacing: style.letterSpacing ?? null,
    textAlign: style.textAlignHorizontal?.toLowerCase() ?? null,
    color: extractFillColor(node.fills),
  };
}

// Extract spacing/layout from auto-layout frames
function extractLayout(node) {
  if (node.layoutMode === undefined) return null;
  return {
    direction: node.layoutMode === 'HORIZONTAL' ? 'row' : 'column',
    gap: node.itemSpacing ?? 0,
    paddingTop: node.paddingTop ?? 0,
    paddingBottom: node.paddingBottom ?? 0,
    paddingLeft: node.paddingLeft ?? 0,
    paddingRight: node.paddingRight ?? 0,
    alignment: node.primaryAxisAlignItems ?? null,
    crossAlignment: node.counterAxisAlignItems ?? null,
  };
}

// Check if a node is visually meaningful (skip hidden/empty)
function isVisible(node) {
  if (node.visible === false) return false;
  if (!node.absoluteBoundingBox) return false;
  const { width, height } = node.absoluteBoundingBox;
  if (width <= 0 || height <= 0) return false;
  return true;
}

// Check if a node is within the bounds of its parent frame
function isInsideFrame(nodeBox, frameBox) {
  return (
    nodeBox.x >= frameBox.x &&
    nodeBox.y >= frameBox.y &&
    nodeBox.x + nodeBox.width <= frameBox.x + frameBox.width &&
    nodeBox.y + nodeBox.height <= frameBox.y + frameBox.height
  );
}

/**
 * Recursively walk a Figma node tree and collect normalized nodes.
 * @param {object} node - current Figma node
 * @param {object} frameBox - absoluteBoundingBox of the root frame
 * @param {number} depth - current depth in tree
 * @param {string|null} parentId - normalized parent id
 * @returns {Array} flat list of normalized nodes
 */
function walkNode(node, frameBox, depth = 0, parentId = null) {
  if (!isVisible(node)) return [];
  if (!RELEVANT_TYPES.has(node.type)) return [];

  const box = node.absoluteBoundingBox;

  // Skip nodes that are completely outside the frame (off-canvas overflow)
  if (!isInsideFrame(box, frameBox)) return [];

  // Convert to frame-relative coordinates
  const relX = box.x - frameBox.x;
  const relY = box.y - frameBox.y;

  const normalized = {
    id: node.id,
    name: node.name,
    type: toSemanticType(node.type, node),
    figmaType: node.type,

    // Geometry — frame-relative
    x: relX,
    y: relY,
    w: box.width,
    h: box.height,

    // Text content (TEXT nodes only)
    text: node.type === 'TEXT' ? (node.characters ?? '') : '',

    // Styles
    typography: node.type === 'TEXT' ? extractTypography(node) : null,
    layout: extractLayout(node),
    fill: extractFillColor(node.fills),
    borderRadius: node.cornerRadius ?? null,
    opacity: node.opacity ?? 1,

    // Tree metadata
    depth,
    parentId,
    source: 'figma',
  };

  const results = [normalized];

  // Recurse into children
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      const childNodes = walkNode(child, frameBox, depth + 1, node.id);
      results.push(...childNodes);
    }
  }

  return results;
}

/**
 * Normalize a full Figma API response for a specific frame.
 * 
 * @param {object} figmaJson - raw response from Figma GET /v1/files/:key
 * @param {string} frameName - name of the top-level frame to extract (e.g. "Homepage")
 *                             if null, uses the first FRAME found
 * @returns {{ frame: object, nodes: Array }} normalized node list + frame metadata
 */
function normalizeFigmaFrame(figmaJson, frameName = null) {
  // Navigate to the document canvas
  const document = figmaJson.document;
  const pages = document.children;

  let targetFrame = null;

  for (const page of pages) {
    for (const child of page.children ?? []) {
      if (child.type !== 'FRAME' && child.type !== 'COMPONENT') continue;
      if (frameName === null || child.name === frameName) {
        targetFrame = child;
        break;
      }
    }
    if (targetFrame){ 
      console.log('Frame origin:', targetFrame.absoluteBoundingBox);
      break;
    }
  }

  if (!targetFrame) {
    throw new Error(`Frame "${frameName}" not found in Figma document`);
  }
  // In normalizeFigmaFrame(), after finding targetFrame:
// If this shows y: 33 or x: 36, that offset isn't being subtracted from children
  const frameBox = targetFrame.absoluteBoundingBox;
  const nodes = walkNode(targetFrame, frameBox, 0, null);

  return {
    frame: {
      id: targetFrame.id,
      name: targetFrame.name,
      width: frameBox.width,
      height: frameBox.height,
    },
    nodes,
  };
}

module.exports = { normalizeFigmaFrame };