// HTML authored in the admin UI (content pages, home news) is rendered through
// DOMPurify: node admins are less trusted than the repository, and auth tokens
// live in localStorage, so no script, event handler or javascript: URL may
// reach the DOM.

import DOMPurify from "dompurify";
import { nodeUrl, siteUrl } from "./base";

const purifier = DOMPurify();

// Paths are written node-relative so one file works under any base path:
// href="/search" is an SPA route of this node, and a relative
// src="people/x.jpg" is a file in config/<node>/assets/. External links open
// in a new tab without a referrer or an opener handle.
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    const href = node.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else if (/^\/(?!\/)/.test(href)) {
      node.setAttribute("href", siteUrl(href));
    }
  }
  if (node.tagName === "IMG" && node.hasAttribute("src")) {
    const src = node.getAttribute("src") ?? "";
    if (!/^([a-z][a-z0-9+.-]*:|\/)/i.test(src)) {
      node.setAttribute("src", nodeUrl(`/config/assets/${src}`));
    }
  }
});

export function sanitizeHtml(html: string): string {
  // The HTML profile: no scripts, styles, forms, iframes or event handlers.
  return purifier.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
}
