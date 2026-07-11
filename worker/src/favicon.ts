// The service favicon: the landing wordmark (cream "nzip", coral z) in a
// rounded square on the landing background #1e1810. Baked as a 64x64 PNG so
// every browser shows the same letterforms — an SVG <text> favicon would
// render with whatever font the viewer's platform substitutes.
//
// Source artwork (regenerate the PNG by rendering this at 64x64 with
// transparent background, e.g. a headless-browser element screenshot):
//
//   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
//     <rect width="64" height="64" rx="14" fill="#1e1810"/>
//     <text x="33" y="33" text-anchor="middle" dominant-baseline="central"
//       font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
//       font-weight="700" font-size="26" letter-spacing="-4.7"
//       fill="#f2e8d4">n<tspan fill="#ff6b4a">z</tspan>ip</text>
//   </svg>

const FAVICON_PNG_BASE64 =
  "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";

export const FAVICON_PNG: Uint8Array = Uint8Array.from(
  atob(FAVICON_PNG_BASE64),
  (c) => c.charCodeAt(0),
);
