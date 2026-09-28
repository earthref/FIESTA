// The node header's letter logo (components/node-header.tsx) as an SVG data
// URL: the key's first letter, serif bold in the node color, in a white
// rounded square outlined in that color. Used as the favicon and in admin lists.

const SERIF = 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function nodeLogoUrl(key: string, color: string): string {
  const letter = escapeXml(key.charAt(0) || "F");
  const fill = escapeXml(color);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    `<rect x="1" y="1" width="30" height="30" rx="4" fill="#fff" stroke="${fill}" stroke-width="2"/>` +
    `<text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-family='${SERIF}' ` +
    `font-weight="700" font-size="24" fill="${fill}">${letter}</text>` +
    "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Point the page's favicon at a node's letter logo. */
export function setNodeFavicon(key: string, color: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = nodeLogoUrl(key, color);
}
