/** What we propose to build in Figma, in Figma's own vocabulary. */
import type { Rect, TextLine } from './ir.js';

export type Fill =
  | { type: 'SOLID'; color: string }
  | { type: 'GRADIENT_LINEAR'; angle: number; stops: { pos: number; color: string }[] }
  | { type: 'IMAGE'; src: string; fit: string }
  | { type: 'RASTER'; tile: string };            // bottom rung: the oracle tile itself

export type Effect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  x: number; y: number; blur: number; spread: number; color: string;
};

export type Stroke = { top: number; right: number; bottom: number; left: number; color: string };

export type TextRun = TextLine & {
  family: string; size: number; weight: string; italic: boolean;
  color: string; letterSpacing: number; decoration: string;
};

/** Ladder position. `reason` is why it is not one rung higher. */
export type Rung = 'vector' | 'sampled' | 'raster';

export type CandidateNode = {
  id: number; parent: number | null; name: string; rect: Rect;
  fills: Fill[];
  stroke?: Stroke;
  radii: [number, number, number, number];       // tl, tr, br, bl
  effects: Effect[];
  opacity: number;
  clip: boolean;
  text?: TextRun[];
  rung: Rung;
  reason?: string;
  score?: number;                                // mean deltaE against this node's oracle tile
};

export type CandidateIR = {
  url: string; size: string;
  page: { w: number; h: number };
  background: string;
  nodes: CandidateNode[];
};
