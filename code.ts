// This plugin will open a window to prompt the user to enter a number, and
// it will then create that many rectangles on the screen.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// Define message types for communication between Figma and UI
interface TextData {
  characters: string
  fontSize: number
  fontFamily: string
  fontStyle: string
  lineHeight: number
  currentWidth: number
  currentHeight: number
  shape: ShapeData | null
  // Font calibration: Figma's real rendered width of `sample` at `sampleFontSize`.
  // The UI compares this against Pretext's measurement to correct for fonts the
  // plugin's canvas can't measure accurately (see handleGetSelectedText).
  sample: string
  sampleWidth: number
  sampleFontSize: number
  id: string
}

interface ShapeBox {
  x: number
  y: number
  width: number
  height: number
}

interface ShapeData extends ShapeBox {
  // Outline as SVG path segments (from node.fillGeometry) so the UI can
  // rasterize the real shape, not just its bounding box.
  paths: { data: string; windingRule: string }[]
}

interface ApplyData {
  id: string
  fontSize: number
  mode: 'box' | 'shape'
  text?: string
  box?: ShapeBox
  lineHeight?: number
  align?: 'LEFT' | 'CENTER'
}

// This shows the HTML page in "ui.html".
figma.showUI(__html__, {
  width: 360,
  height: 540,
  title: 'Smart Text · Fit to Shape'
});

// Calls to "parent.postMessage" from within the HTML page will trigger this
// callback. The callback will be passed the "pluginMessage" property of the
// posted message.
figma.ui.onmessage = async (msg) => {
  // Handle different message types from the UI
  if (msg.type === 'get-selected-text') {
    await handleGetSelectedText();
  }

  if (msg.type === 'apply-font-size') {
    await handleApplyFontSize(msg.data as ApplyData);
  }

  if (msg.type === 'load-settings') {
    const saved = await figma.clientStorage.getAsync('smart-text-settings');
    figma.ui.postMessage({ type: 'settings', data: saved || null });
  }

  if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync('smart-text-settings', msg.settings);
  }

  if (msg.type === 'close-plugin') {
    figma.closePlugin();
  }
};

// Reference size for the calibration sample (width scales linearly, so the
// exact value cancels out — a larger one just gives a more precise ratio).
const CALIBRATION_SIZE = 100;

// Measure Figma's real rendered width of a sample string in a given font,
// using a throwaway hidden text node. Returns 0 on any failure (UI treats
// that as "no correction").
async function measureFigmaWidth(fontName: FontName, sample: string): Promise<number> {
  try {
    await figma.loadFontAsync(fontName);
    const probe = figma.createText();
    probe.visible = false;
    probe.fontName = fontName;
    probe.fontSize = CALIBRATION_SIZE;
    probe.textAutoResize = 'WIDTH_AND_HEIGHT';
    probe.characters = sample;
    const width = probe.width;
    probe.remove();
    return width;
  } catch (e) {
    return 0;
  }
}

// Function to read selected text layers and send data to UI
async function handleGetSelectedText() {
  const selection = figma.currentPage.selection;
  
  // Filter to only text nodes
  const textNodes = selection.filter(
    node => node.type === 'TEXT'
  ) as TextNode[];

  if (textNodes.length === 0) {
    figma.ui.postMessage({
      type: 'error',
      message: 'Please select at least one text layer'
    });
    return;
  }

  // Shape mode: exactly one text layer + one filled shape selected together.
  const shapeNode = selection.find(
    node => node.type !== 'TEXT'
      && 'fillGeometry' in node
      && (node as unknown as GeometryMixin).fillGeometry.length > 0
  ) as (SceneNode & GeometryMixin) | undefined;

  const shape: ShapeData | null = (shapeNode && textNodes.length === 1)
    ? {
        x: shapeNode.x,
        y: shapeNode.y,
        width: shapeNode.width,
        height: shapeNode.height,
        paths: shapeNode.fillGeometry.map(p => ({ data: p.data, windingRule: p.windingRule }))
      }
    : null;
  
  // Extract text data from each selected node
  const textDataList: TextData[] = [];
  for (const node of textNodes) {
    // Handle font size (can be a number or object)
    const fontSize = typeof node.fontSize === 'number'
      ? node.fontSize
      : 12;

    const fontName = node.fontName as FontName;

    // Handle line height (can be 'AUTO' or an object)
    let lineHeightPx = 1.25 * fontSize; // default fallback for AUTO (~font's built-in metric)
    if (node.lineHeight && typeof node.lineHeight === 'object') {
      if (node.lineHeight.unit === 'PIXELS') {
        lineHeightPx = node.lineHeight.value;
      } else if (node.lineHeight.unit === 'PERCENT') {
        lineHeightPx = (node.lineHeight.value / 100) * fontSize;
      }
    }

    // Calibration sample: a slice of the real text (its actual glyphs), on one
    // line. Figma measures its true width; the UI compares against Pretext.
    const sample = (node.characters.replace(/\s+/g, ' ').trim() || 'The quick brown fox')
      .substring(0, 200);
    const sampleWidth = await measureFigmaWidth(fontName, sample);

    textDataList.push({
      characters: node.characters,
      fontSize: fontSize,
      fontFamily: fontName.family,
      fontStyle: fontName.style,
      lineHeight: lineHeightPx,
      currentWidth: node.width,
      currentHeight: node.height,
      shape: shape,
      sample: sample,
      sampleWidth: sampleWidth,
      sampleFontSize: CALIBRATION_SIZE,
      id: node.id
    });
  }

  // Send the collected data to the UI
  figma.ui.postMessage({
    type: 'text-data',
    data: textDataList
  });
}

// Function to apply a new font size so the text fills its (fixed) box.
async function handleApplyFontSize(data: ApplyData) {
  const node = await figma.getNodeByIdAsync(data.id) as TextNode | null;
  if (!node || node.type !== 'TEXT' || node.characters.length === 0) {
    return;
  }

  // Setting a uniform font size / new characters requires every font used in
  // the node to be loaded first (a text node can contain mixed fonts).
  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(fonts.map(f => figma.loadFontAsync(f)));

  // Lock the box so changing the font size resizes the text inside it,
  // not the frame itself.
  node.textAutoResize = 'NONE';

  if (data.mode === 'shape' && data.text != null && data.box) {
    // Approach A: pre-broken lines + centered alignment approximate the shape.
    node.textAlignHorizontal = data.align === 'LEFT' ? 'LEFT' : 'CENTER';
    node.textAlignVertical = 'CENTER';
    node.characters = data.text;
    node.fontSize = data.fontSize;
    // Pin the line height to what the fit planned. Without this Figma uses AUTO
    // line height (taller) and the text overflows the shape.
    if (data.lineHeight != null) {
      node.lineHeight = { value: data.lineHeight, unit: 'PIXELS' };
    }
    // Overlay the text box exactly on the shape.
    node.x = data.box.x;
    node.y = data.box.y;
    node.resize(data.box.width, data.box.height);
  } else {
    node.fontSize = data.fontSize;
    // Pin line height too, so an old fixed-pixel line height can't make the
    // resized text overlap itself.
    if (data.lineHeight != null) {
      node.lineHeight = { value: data.lineHeight, unit: 'PIXELS' };
    }
  }
}