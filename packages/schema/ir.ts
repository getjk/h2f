/** Boundary schemas. Every stage speaks these and nothing else. */

export type Rect = { x: number; y: number; w: number; h: number };

/** One rendered line of text, positioned in page coordinates. */
export type TextLine = { text: string; rect: Rect; baseline: number };

/** Style values we care about, already resolved by Chrome. */
export type Style = Record<string, string>;

export type ElementNode = {
  id: number;
  parent: number | null;
  tag: string;
  name: string;              // human layer name: semantic tag, class, heading text
  rect: Rect;                // page coordinates, border box
  style: Style;
  vars: Record<string, string>;  // css property -> custom property token it traces to
  text?: { content: string; lines: TextLine[] };
  image?: { src: string; natural: { w: number; h: number }; fit: string; position: string };
  svg?: string;
  paintOrder: number;
  /** Set when the element cannot be pixel-isolated (blend/backdrop/ancestor-clip). */
  noIsolate?: string;
  /** Structural fingerprint: tag+class skeleton, ignoring text and src. */
  hash: string;
};

export type CaptureSize = 'L' | 'M' | 'S';

export type StructureIR = {
  url: string;
  title: string;
  size: CaptureSize;
  viewport: { w: number; h: number; dpr: number };
  layout: { w: number; h: number };        // what CSS actually sees
  injectedViewportMeta?: boolean;          // page had none; we laid it out at device width
  /** What the page needed before it could be captured -- and what is still in the way. */
  prepared: {
    dismissed: string[];                                          // banners and dialogs clicked away
    blockers: { tag: string; cls: string; area: number }[];        // overlays still covering the page
    videos: { src: string; poster: string; w: number; h: number }[];
  };
  page: { w: number; h: number };
  nodes: ElementNode[];
  fonts: { family: string; weight: string; style: string; src: string | null }[];
  tokens: Record<string, string>;   // --brand-500 -> #5b21b6
};

/** Manifest of isolated per-element PNGs: the truth we verify against. */
export type Oracle = {
  size: CaptureSize;
  full: string;                       // full-page reference png
  tiles: Record<number, string>;      // node id -> png path (transparent, DPR-scaled)
};
