// HTML authored in the admin UI (content pages, home news) is rendered through
// DOMPurify: node admins are less trusted than the repository, and auth tokens
// live in localStorage, so no script, event handler or javascript: URL may
// reach the DOM.

import DOMPurify from "dompurify";

const purifier = DOMPurify();

// External links open in a new tab without a referrer or an opener handle.
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    const href = node.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
});

export function sanitizeHtml(html: string): string {
  // The HTML profile: no scripts, styles, forms, iframes or event handlers.
  return purifier.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
}
