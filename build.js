// build.js — bundles ui.js (with Pretext) and INLINES it into ui.html.
// Figma plugin UIs are injected via srcdoc with no origin, so an external
// <script src="..."> can never load. Everything must live inside ui.html.
const esbuild = require('esbuild');
const fs = require('fs');

console.log('📦 Building UI bundle...');

if (!fs.existsSync('ui.js')) {
  console.error('❌ ui.js not found! Please create ui.js first.');
  process.exit(1);
}

esbuild.build({
  entryPoints: ['ui.js'],
  bundle: true,
  write: false, // keep output in memory so we can inline it
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}).then((result) => {
  const bundle = result.outputFiles[0].text;

  // Neutralize any accidental "</script>" in the bundle so it can't close the tag early.
  const safeBundle = bundle.replace(/<\/script>/gi, '<\\/script>');

  const marker = /<!-- BUNDLE:START -->[\s\S]*?<!-- BUNDLE:END -->/;
  const inlined = `<!-- BUNDLE:START -->\n  <script>\n${safeBundle}\n  </script>\n  <!-- BUNDLE:END -->`;

  let html = fs.readFileSync('ui.html', 'utf8');
  if (!marker.test(html)) {
    console.error('❌ Could not find <!-- BUNDLE:START/END --> markers in ui.html');
    process.exit(1);
  }
  html = html.replace(marker, inlined);

  // Embed the Space Grotesk variable font as base64 (networkAccess is "none",
  // so we can't load webfonts by URL). Regenerated from space-grotesk.woff2.
  const fontMarker = /\/\* FONT:START \*\/[\s\S]*?\/\* FONT:END \*\//;
  if (fontMarker.test(html) && fs.existsSync('space-grotesk.woff2')) {
    const b64 = fs.readFileSync('space-grotesk.woff2').toString('base64');
    const fontFace =
      "/* FONT:START */\n" +
      "    @font-face { font-family: 'Space Grotesk'; font-style: normal; " +
      "font-weight: 300 700; font-display: block; " +
      "src: url(data:font/woff2;base64," + b64 + ") format('woff2'); }\n" +
      "    /* FONT:END */";
    html = html.replace(fontMarker, fontFace);
    console.log('✅ Embedded Space Grotesk (' + b64.length + ' b64 chars)');
  }

  fs.writeFileSync('ui.html', html);

  console.log('✅ Inlined bundle into ui.html (' + safeBundle.length + ' bytes)');
}).catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
