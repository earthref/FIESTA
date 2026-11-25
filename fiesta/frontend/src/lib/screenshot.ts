/** Elements carrying this attribute (the contact modal itself) are left out of
 * the screenshot. */
export const SCREENSHOT_EXCLUDE = "data-screenshot-exclude";

const MAX_WIDTH = 1600;

let standard: string[] | undefined;

function standardProperties(): string[] {
  if (!standard) {
    const style = getComputedStyle(document.documentElement);
    standard = Array.from({ length: style.length }, (_, i) => style.item(i)).filter(
      (name) => !name.startsWith("--"),
    );
  }
  return standard;
}

/**
 * A JPEG data URL of what the person sees: the viewport at its current scroll
 * position, fixed bars included, scaled to at most 1600px wide. Rendered from
 * the DOM (modern-screenshot, loaded on first use), so it asks no permission;
 * WebGL canvases and images without CORS may come out blank. null on failure.
 */
export async function capturePage(): Promise<string | null> {
  try {
    const { domToCanvas } = await import("modern-screenshot");
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const canvas = await domToCanvas(document.body, {
      width,
      height,
      scale: Math.min(1, MAX_WIDTH / width),
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
      // Shift the page up by the scroll offset; fixed bars stay put.
      style: { marginTop: `${-window.scrollY}px` },
      // Leave out the contact modal, and anything wholly below the window
      // (most of a long results list), which cannot show and halves the time.
      filter: (node) =>
        !(
          node instanceof Element &&
          (node.hasAttribute(SCREENSHOT_EXCLUDE) || node.getBoundingClientRect().top >= height)
        ),
      // A table keeps its computed height in the clone; with the rows below
      // the window left out, the rest would stretch to fill it.
      onCloneEachNode: (cloned) => {
        if (cloned instanceof HTMLTableElement || cloned instanceof HTMLTableSectionElement) {
          cloned.style.removeProperty("height");
          cloned.style.removeProperty("block-size");
        }
      },
      // Standard properties only: Chrome lists every theme and Tailwind custom
      // property on every element, which doubled the time, and the computed
      // values they feed are copied anyway.
      includeStyleProperties: standardProperties(),
      timeout: 10_000,
    });
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}
