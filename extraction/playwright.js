// playwright-extractor.js
const { chromium } = require('playwright');

const RELEVANT_TAGS = new Set([
  'body', 'main', 'section', 'article', 'header', 'footer', 'nav', 'aside',
  'div', 'ul', 'ol', 'li', 'figure', 'form', 'button', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'span', 'label', 'strong', 'em', 'small',
  'img', 'svg', 'canvas', 'picture', 'video',
  'table', 'td', 'th', 'tr'
]);

const MIN_AREA = 4;

async function extractTree(page) {
  // ✅ Pass everything as a single object — the only safe way across the boundary
  return page.evaluate(({ relevantTags, minArea }) => {
    const STYLE_PROPS = [
      'display', 'flexDirection', 'justifyContent', 'alignItems',
      'gap', 'columnGap', 'rowGap',
      'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
      'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
      'backgroundColor', 'color', 'opacity',
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign',
      'borderRadius', 'borderColor', 'borderWidth', 'borderStyle',
      'boxShadow', 'overflow', 'position', 'zIndex'
    ];

    const TEXT_TAGS = new Set(['h1','h2','h3','h4','h5','h6','p','span','label','strong','em','small','a','button']);
    const IMAGE_TAGS = new Set(['img', 'svg', 'canvas', 'picture', 'video']);

    function getType(tag) {
      if (IMAGE_TAGS.has(tag)) return 'image';
      if (TEXT_TAGS.has(tag)) return 'text';
      return 'container';
    }

    function extractNode(el) {
      const tag = el.tagName.toLowerCase();
      if (!relevantTags.includes(tag)) return null;  // array, not Set — Sets don't serialize

      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w * h < minArea) return null;

      const cs = window.getComputedStyle(el);
      const styles = {};
      for (const prop of STYLE_PROPS) {
        styles[prop] = cs[prop] ?? null;
      }

      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ')
        .trim();

      const children = [];
      for (const child of el.children) {
        const childNode = extractNode(child);
        if (childNode) children.push(childNode);
      }

      return {
        type: getType(tag),
        tag,
        text: directText || el.getAttribute('alt') || el.getAttribute('aria-label') || '',
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: w,
        height: h,
        styles,
        children,
      };
    }

    return extractNode(document.body);

  // ✅ Single object argument — this is what fixes your error
  }, { relevantTags: [...RELEVANT_TAGS], minArea: MIN_AREA });
}

async function extractDomData(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const tree = await extractTree(page);
  await browser.close();

  return {
    url,
    viewport: { width: 1440, height: 900 },
    extractedAt: new Date().toISOString(),
    tree,
  };
}

module.exports = { extractDomData };