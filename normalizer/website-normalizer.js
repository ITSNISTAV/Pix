/**
 * DOM Normalizer
 * Converts Playwright-extracted DOM tree into the same normalized node schema
 * as the Figma normalizer — section-relative coordinates.
 */

// HTML tags we consider semantic containers worth matching
const CONTAINER_TAGS = new Set([
  'div', 'section', 'article', 'main', 'header', 'footer',
  'nav', 'aside', 'figure', 'form', 'ul', 'ol', 'li',
  'button', 'a', 'card'
]);

const TEXT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'label', 'strong', 'em', 'small', 'td', 'th', 'caption'
]);

const IMAGE_TAGS = new Set(['img', 'svg', 'canvas', 'video', 'picture']);
const ICON_TAGS = new Set(['svg', 'i']);

// Minimum area to consider a node worth matching (filters invisible wrappers)
const MIN_AREA = 4; // px²

function toSemanticType(tag, domType,node) {
  if (domType === 'text') return 'text';
  if (IMAGE_TAGS.has(tag)) return 'image';
  if (ICON_TAGS.has(tag)) return 'icon';
  if ((tag === 'li' || tag === 'a') && node.text && node.children.length === 0) return 'text';
  return 'container';
}

// Parse a CSS color string to hex — handles rgb(), rgba(), hex
function cssColorToHex(cssColor) {
  if (!cssColor || cssColor === 'transparent' || cssColor === 'rgba(0, 0, 0, 0)') return null;

  // Already hex
  if (cssColor.startsWith('#')) return cssColor;

  // rgb(r, g, b) or rgba(r, g, b, a)
  const match = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    const [, r, g, b] = match;
    return `#${Number(r).toString(16).padStart(2, '0')}${Number(g).toString(16).padStart(2, '0')}${Number(b).toString(16).padStart(2, '0')}`;
  }

  return null;
}

// Parse a px string like "16px" → number 16
function parsePx(value) {
  if (!value || value === 'normal' || value === 'none') return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

// Extract opacity from rgba color or a dedicated opacity value
function extractOpacity(styles) {
  if (!styles) return 1;
  if (styles.opacity !== undefined) {
    const o = parseFloat(styles.opacity);
    return isNaN(o) ? 1 : o;
  }
  // Check rgba alpha channel from background-color
  const bg = styles.backgroundColor ?? '';
  const match = bg.match(/rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/);
  if (match) return parseFloat(match[1]);
  return 1;
}

// Build typography object from computed CSS styles
function extractTypography(styles, textContent) {
  if (!styles) return null;
  return {
    fontFamily: styles.fontFamily ? styles.fontFamily.split(',')[0].replace(/['"]/g, '').trim() : null,
    fontSize: parsePx(styles.fontSize),
    fontWeight: styles.fontWeight ? parseInt(styles.fontWeight) : null,
    lineHeight: parsePx(styles.lineHeight),
    letterSpacing: parsePx(styles.letterSpacing),
    textAlign: styles.textAlign ?? null,
    color: { hex: cssColorToHex(styles.color), opacity: 1 },
  };
}

// Build layout object from computed CSS styles
function extractLayout(styles) {
  if (!styles) return null;
  if (styles.display !== 'flex' && styles.display !== 'grid') return null;
  return {
    direction: styles.flexDirection === 'row' ? 'row' : 'column',
    gap: parsePx(styles.gap) ?? parsePx(styles.columnGap) ?? 0,
    paddingTop: parsePx(styles.paddingTop) ?? 0,
    paddingBottom: parsePx(styles.paddingBottom) ?? 0,
    paddingLeft: parsePx(styles.paddingLeft) ?? 0,
    paddingRight: parsePx(styles.paddingRight) ?? 0,
    alignment: styles.justifyContent ?? null,
    crossAlignment: styles.alignItems ?? null,
  };
}

// Filter out nodes that are invisible or too small to matter
function isMeaningful(node, sectionBox) {
  const w = node.width ?? 0;
  const h = node.height ?? 0;
  if (w * h < MIN_AREA) return false;

  // Must overlap with the section (not entirely outside)
  if (node.x + w < sectionBox.x) return false;
  if (node.y + h < sectionBox.y) return false;
  if (node.x > sectionBox.x + sectionBox.width) return false;
  if (node.y > sectionBox.y + sectionBox.height) return false;

  return true;
}

/**
 * Recursively walk the DOM tree and collect normalized nodes.
 * @param {object} node - current DOM node from Playwright
 * @param {object} sectionBox - { x, y, width, height } of the root section
 * @param {number} depth - current depth
 * @param {string|null} parentId - generated parent id
 * @param {number} counter - mutable counter for generating ids
 * @returns {Array} flat list of normalized nodes
 */
function walkNode(node, sectionBox, depth = 0, parentId = null, counter = { val: 0 }) {
  if (!isMeaningful(node, sectionBox)) return [];

  const id = `dom-node-${counter.val++}`;
  const tag = (node.tag ?? '').toLowerCase();
  const semanticType = toSemanticType(tag, node.type,node);

  // Convert to section-relative coordinates
  const relX = node.x - sectionBox.x;
  const relY = node.y - sectionBox.y;

  const styles = node.styles ?? null;

  const normalized = {
    id,
    name: `${tag}#${id}`,    // no semantic name from DOM, use tag+id
    type: semanticType,
    domTag: tag,

    // Geometry — section-relative
    x: relX,
    y: relY,
    w: node.width,
    h: node.height,

    // Text content
    text: node.text ?? '',

    // Styles
    typography: (semanticType === 'text' || TEXT_TAGS.has(tag))
      ? extractTypography(styles, node.text)
      : null,
    layout: extractLayout(styles),
    fill: styles?.backgroundColor
      ? { hex: cssColorToHex(styles.backgroundColor), opacity: extractOpacity(styles) }
      : null,
    borderRadius: parsePx(styles?.borderRadius),
    opacity: extractOpacity(styles),

    // Tree metadata
    depth,
    parentId,
    source: 'dom',
  };

  const results = [normalized];

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      const childNodes = walkNode(child, sectionBox, depth + 1, id, counter);
      results.push(...childNodes);
    }
  }

  return results;
}

/**
 * Normalize a Playwright DOM tree.
 * 
 * @param {object} domJson - output from your Playwright extractor ({ tree: { ... } })
 * @param {object} options
 * @param {string} [options.rootTag='body'] - tag of the root node to start from
 * @param {number} [options.sectionIndex=0] - which top-level section to use as the anchor
 *                                            (0 = first section/main under body)
 * @returns {{ section: object, nodes: Array }}
 */
function normalizeDomTree(domJson, options = {}) {
  const { rootTag = 'body', sectionIndex = 0 } = options;

  const root = domJson.tree;
  if (!root) throw new Error('DOM JSON must have a "tree" property at root');

  // Find the anchor section — the top-level layout container to normalize against
  const topLevelContainers = (root.children ?? []).filter(child => {
    const tag = (child.tag ?? '').toLowerCase();
    return CONTAINER_TAGS.has(tag) && child.width > 0 && child.height > 0;
  });

  if (topLevelContainers.length === 0) {
    throw new Error('No meaningful top-level containers found under root');
  }

 const sectionBox = {
  x: root.x,        // 0
  y: root.y,        // 0
  width: root.width,
  height: root.height,
};
  // Temporarily log this in dom-normalizer.js
console.log('DOM root children:', domJson.tree.children.map(c => ({
  tag: c.tag,
  x: c.x,
  y: c.y,
  w: c.width,
  h: c.height
})));

  const counter = { val: 0 };
  const nodes = walkNode(root, sectionBox, 0, null, counter);
  

 return {
  section: {
    tag: root.tag,
    width: root.width,
    height: root.height,
  },
  nodes,
};
}

module.exports = { normalizeDomTree };