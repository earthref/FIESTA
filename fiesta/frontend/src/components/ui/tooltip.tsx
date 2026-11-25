import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { anchorBox, type Box, placeTooltip } from "@/lib/tooltip-position";
import { cx } from "@/lib/utils";

/** The tooltip's look in both color schemes (the plots' tooltips use the same colors). */
export const tooltipClass =
  "pointer-events-none rounded-sm border border-(color:--er-plot-tooltip-line) bg-(--er-plot-tooltip) px-2 py-1 text-[13px] leading-snug font-normal text-ink shadow-md";

/** Hover time before a tooltip opens. */
const DELAY = 400;
/** After one closes, the next opens at once for this long (moving along a toolbar). */
const LINGER = 300;

interface Tip {
  text: string;
  box: Box;
  prefer: "top" | "bottom";
}

/** An element whose native tooltip is held back while ours stands in for it. */
interface Adopted {
  anchor: Element;
  text: string;
  release: () => void;
}

/**
 * The app's one tooltip. Mounted once, it takes over every native tooltip — an
 * HTML `title` attribute or an SVG `<title>` child, in core and in plugins — so
 * a component only sets `title=` as it always has. The text opens after a short
 * hover or on keyboard focus, in the theme's colors, above its element (below
 * it or moved sideways near a viewport edge; at the pointer on a large element).
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let adopted: Adopted | null = null;
    let byFocus = false;
    let visible = false;
    let closedAt = Number.NEGATIVE_INFINITY;
    let timer = 0;
    let watch = 0;
    let pointer: { x: number; y: number } | null = null;

    const show = () => {
      if (!adopted?.text) return;
      if (!adopted.anchor.isConnected) return drop();
      visible = true;
      setTip({
        text: adopted.text,
        ...anchorBox(adopted.anchor.getBoundingClientRect(), byFocus ? null : pointer),
      });
      // An anchor removed under a still pointer fires no event.
      window.clearInterval(watch);
      watch = window.setInterval(() => !adopted?.anchor.isConnected && drop(), 400);
    };
    /** Close the tooltip, keeping its element (so that it stays closed there). */
    const dismiss = () => {
      window.clearTimeout(timer);
      window.clearInterval(watch);
      if (visible) closedAt = performance.now();
      visible = false;
      setTip(null);
    };
    const drop = () => {
      dismiss();
      adopted?.release();
      adopted = null;
    };
    const take = (anchor: Element, focused: boolean) => {
      if (adopted?.anchor === anchor) return;
      drop();
      // The element's text changed under the pointer ("Link copied"): show the new one.
      adopted = adopt(anchor, (text) => (text ? show() : dismiss()));
      if (!adopted) return;
      byFocus = focused;
      timer = window.setTimeout(show, performance.now() - closedAt < LINGER ? 0 : DELAY);
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY };
      const anchor = findAnchor(event.target, adopted?.anchor);
      if (anchor) take(anchor, false);
      else drop();
    };
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.matches(":focus-visible")) return;
      const anchor = findAnchor(target, adopted?.anchor);
      if (anchor) take(anchor, true);
    };
    const onBlur = () => byFocus && drop();

    const options = { capture: true, passive: true };
    document.addEventListener("pointerover", onOver, options);
    document.addEventListener("pointermove", onMove, options);
    document.addEventListener("pointerdown", dismiss, options);
    document.addEventListener("keydown", dismiss, options);
    document.addEventListener("scroll", dismiss, options);
    document.addEventListener("focusin", onFocus, options);
    document.addEventListener("focusout", onBlur, options);
    document.documentElement.addEventListener("pointerleave", drop);
    window.addEventListener("blur", drop);
    window.addEventListener("resize", dismiss);
    return () => {
      drop();
      document.removeEventListener("pointerover", onOver, options);
      document.removeEventListener("pointermove", onMove, options);
      document.removeEventListener("pointerdown", dismiss, options);
      document.removeEventListener("keydown", dismiss, options);
      document.removeEventListener("scroll", dismiss, options);
      document.removeEventListener("focusin", onFocus, options);
      document.removeEventListener("focusout", onBlur, options);
      document.documentElement.removeEventListener("pointerleave", drop);
      window.removeEventListener("blur", drop);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  // Measured and placed before the first paint, so it never shows at the corner.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !tip) return;
    const { width, height } = element.getBoundingClientRect();
    const viewport = {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
    const placed = placeTooltip(tip.box, { width, height }, viewport, tip.prefer);
    element.style.left = `${Math.round(placed.left)}px`;
    element.style.top = `${Math.round(placed.top)}px`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={cx(
        tooltipClass,
        // w-max: the width must not depend on how close to the right edge it is.
        "fixed top-0 left-0 z-[70] w-max max-w-[min(22rem,calc(100vw-16px))] whitespace-pre-line break-words",
      )}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

/** The nearest element with a native tooltip (or the one already taken over). */
function findAnchor(target: EventTarget | null, current: Element | undefined): Element | null {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el === current) return el;
    if (el instanceof HTMLElement && el.hasAttribute("title")) return el;
    // An outermost <svg>'s title names the image; browsers show no tooltip for it.
    if (el instanceof SVGElement && el.ownerSVGElement && svgTitle(el)) return el;
  }
  return null;
}

function svgTitle(element: Element): SVGTitleElement | null {
  for (const child of element.children) {
    if (child instanceof SVGTitleElement) return child;
  }
  return null;
}

function adopt(anchor: Element, onChange: (text: string) => void): Adopted | null {
  const title = svgTitle(anchor);
  return title ? adoptSvgTitle(anchor, title, onChange) : adoptTitle(anchor, onChange);
}

/**
 * Take over a `title` attribute. It is emptied, not removed: an empty title
 * shows no native tooltip, and React removing or replacing the attribute
 * meanwhile is then a mutation we see (removing an absent one is not), so a
 * stale text is never put back.
 */
function adoptTitle(anchor: Element, onChange: (text: string) => void): Adopted | null {
  const text = anchor.getAttribute("title") ?? "";
  if (!text.trim()) return null;
  const adopted: Adopted = { anchor, text, release: () => {} };

  // The title was the element's accessible name or description; keep it one.
  const named =
    anchor.matches("input, select, textarea") ||
    anchor.hasAttribute("aria-label") ||
    anchor.hasAttribute("aria-labelledby") ||
    Boolean(anchor.textContent?.trim()) ||
    anchor.querySelector("img[alt]:not([alt=''])") !== null;
  const described =
    anchor.getAttribute("aria-label") === text ||
    anchor.hasAttribute("aria-description") ||
    anchor.hasAttribute("aria-describedby");
  const aria = !named ? "aria-label" : !described ? "aria-description" : null;

  const blank = () => {
    anchor.setAttribute("title", "");
    if (aria) anchor.setAttribute(aria, adopted.text);
  };
  const observer = new MutationObserver(() => {
    const next = anchor.getAttribute("title");
    if (next === "") return;
    adopted.text = next?.trim() ? next : "";
    if (next !== null) blank();
    onChange(adopted.text);
  });
  blank();
  observer.observe(anchor, { attributes: true, attributeFilter: ["title"] });

  adopted.release = () => {
    observer.disconnect();
    if (anchor.getAttribute("title") === "" && adopted.text) {
      anchor.setAttribute("title", adopted.text);
    }
    if (aria) anchor.removeAttribute(aria);
  };
  return adopted;
}

/**
 * Take over an SVG `<title>` child the same way: its text nodes are emptied in
 * place (React keeps writing to the same nodes) and filled again on release.
 */
function adoptSvgTitle(
  anchor: Element,
  title: SVGTitleElement,
  onChange: (text: string) => void,
): Adopted | null {
  if (!title.textContent?.trim()) return null;
  const saved = new Map<Text, string>();
  const blank = () => {
    for (const node of title.childNodes) {
      if (node instanceof Text && node.data !== "") {
        saved.set(node, node.data);
        node.data = "";
      }
    }
    for (const node of saved.keys()) if (node.parentNode !== title) saved.delete(node);
    return [...title.childNodes].map((node) => saved.get(node as Text) ?? "").join("");
  };
  const adopted: Adopted = { anchor, text: blank(), release: () => {} };
  const observer = new MutationObserver(() => {
    if (title.textContent === "" && [...saved.keys()].every((node) => node.parentNode === title)) {
      return;
    }
    adopted.text = title.parentNode === anchor ? blank() : "";
    observer.takeRecords();
    onChange(adopted.text);
  });
  observer.observe(title, { characterData: true, childList: true, subtree: true });

  adopted.release = () => {
    observer.disconnect();
    for (const [node, data] of saved) {
      if (node.parentNode === title && node.data === "") node.data = data;
    }
  };
  return adopted;
}
