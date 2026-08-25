import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('usage: node scripts/build-live-visual-fixture.mjs <input> <output>');
}

let html = readFileSync(inputPath, 'utf8');

// The visual proof must inherit the production DOM instead of maintaining a
// second hand-written copy. Runtime producers are removed so deterministic
// authority can be injected without opening real sockets, media or microphones.
html = html.replace(/\n?\s*<script\b[^>]*>[\s\S]*?<\/script>\s*/g, '\n');

const fixtureStyle = `
    <style id="live-visual-fixture-media">
      .youtube-player-shell #youtube-player {
        position: relative;
        min-height: 200px;
        background:
          linear-gradient(to top, rgba(0,0,0,.72), transparent 34%),
          radial-gradient(circle at 35% 38%, #41464f, #1b1e24 42%, #0c0d10 78%);
      }
      .youtube-player-shell #youtube-player::before {
        content: "YouTube";
        position: absolute;
        left: 14px;
        top: 12px;
        color: #d9d9dc;
        font: 600 12px/1.2 system-ui, sans-serif;
        opacity: .76;
      }
      .youtube-player-shell #youtube-player::after {
        content: "▶    ━━━━━━━━━━━━━━━    4:12   ⛶";
        position: absolute;
        left: 14px;
        right: 14px;
        bottom: 10px;
        overflow: hidden;
        color: #efeff1;
        font: 500 12px/1.2 system-ui, sans-serif;
        white-space: nowrap;
      }
      #room-song-artwork {
        background: radial-gradient(circle at 38% 30%, #9e876c, #393138 44%, #15161a 78%);
      }
    </style>
`;

const fixtureRuntime = `
    <script>localStorage.setItem('relay.locale.v1', 'zh-Hant');</script>
    <script src="/i18n.js"></script>
    <script type="module" src="/system-details.js"></script>
    <script type="module" src="/__live-visual-bootstrap.js"></script>
`;

if (!html.includes('</head>') || !html.includes('</body>')) {
  throw new Error('production index is missing expected head/body boundaries');
}

html = html.replace('</head>', `${fixtureStyle}</head>`);
html = html.replace('</body>', `${fixtureRuntime}</body>`);
writeFileSync(outputPath, html);
