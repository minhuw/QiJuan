/**
 * A page turn drawn as a curling sheet on a 2D canvas, as in a printed book.
 *
 * The geometry works in a frame where the turning page lies right of the spine and its bottom
 * free corner travels over the spine to the left. A backward turn mirrors the canvas, and every
 * page image is mirrored back, so pictures never appear reversed.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CurlFold {
  /** Where the lifted corner is now. */
  corner: Point;
  /** A point on the fold line. */
  midpoint: Point;
  /** Unit normal of the fold line, pointing toward the page's free edge. */
  normal: Point;
  /** How far the flap reaches past the fold line, along the normal. */
  depth: number;
  /** The part of the page beyond the fold, where it lay before lifting. */
  flap: Point[];
  /** The part of the page still lying flat. */
  rest: Point[];
}

/** How high the corner lifts halfway through a turn, as a share of the page height. */
const LIFT = 0.12;

/** The fold of a page lying right of the spine at `page.x`, `progress` of the way through a turn. */
export function curlFold(page: Rect, progress: number): CurlFold | null {
  const t = Math.max(0, Math.min(1, progress));
  const { x, y, width: w, height: h } = page;
  if (w <= 0 || h <= 0) return null;
  const start = { x: x + w, y: y + h };
  let corner = { x: start.x - 2 * w * t, y: start.y - h * LIFT * Math.sin(Math.PI * t) };
  // The sheet stays bound at the spine: the corner can be no further from the spine's foot
  // than the page is wide, nor further from its head than the page's diagonal.
  corner = within(corner, { x, y: y + h }, w);
  corner = within(corner, { x, y }, Math.hypot(w, h));
  const dx = start.x - corner.x;
  const dy = start.y - corner.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return null;
  const normal = { x: dx / length, y: dy / length };
  const midpoint = { x: (start.x + corner.x) / 2, y: (start.y + corner.y) / 2 };
  const outline = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  const flap = clipHalfPlane(outline, midpoint, normal, 1);
  const rest = clipHalfPlane(outline, midpoint, normal, -1);
  const depth = Math.max(0, ...flap.map((point) => side(point, midpoint, normal)));
  return { corner, midpoint, normal, depth, flap, rest };
}

function within(point: Point, centre: Point, radius: number): Point {
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius || distance === 0) return point;
  return { x: centre.x + (dx * radius) / distance, y: centre.y + (dy * radius) / distance };
}

function side(point: Point, origin: Point, normal: Point): number {
  return (point.x - origin.x) * normal.x + (point.y - origin.y) * normal.y;
}

/** The part of a convex polygon on one side of a line (Sutherland–Hodgman, one edge). */
export function clipHalfPlane(polygon: readonly Point[], origin: Point, normal: Point, keep: 1 | -1): Point[] {
  const out: Point[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const a = keep * side(current, origin, normal);
    const b = keep * side(next, origin, normal);
    if (a >= 0) out.push(current);
    if ((a >= 0) !== (b >= 0)) {
      const share = a / (a - b);
      out.push({ x: current.x + (next.x - current.x) * share, y: current.y + (next.y - current.y) * share });
    }
  }
  return out;
}

/** The reflection across the fold line, as canvas transform arguments (a, b, c, d, e, f). */
export function foldReflection(fold: Pick<CurlFold, 'midpoint' | 'normal'>): [number, number, number, number, number, number] {
  const { x: nx, y: ny } = fold.normal;
  const k = fold.midpoint.x * nx + fold.midpoint.y * ny;
  return [1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, 2 * k * nx, 2 * k * ny];
}

export interface CurlImage {
  image: CanvasImageSource;
  /** Where the page sits, in the canvas's CSS pixels. */
  rect: Rect;
}

export interface CurlScene {
  /** The canvas size in CSS pixels. */
  width: number;
  height: number;
  /** 'next' turns the right page over to the left; 'prev' turns the left page to the right. */
  direction: 'next' | 'prev';
  /** The page that turns: the old right page going forward, the old left page going back. */
  turning: CurlImage;
  /** The old facing page, which stays put; null when that side of the spread was empty. */
  still: CurlImage | null;
  /** The page printed on the back of the turning sheet: the new facing page. */
  back: CanvasImageSource | null;
  /** The colour behind the pages, used where a side of the spread is empty. */
  background: string;
  /** The colour of a page with nothing printed on it. */
  paper: string;
}

/** Eases a turn in and out, like a hand lifting and laying down a sheet. */
export function easeTurn(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return (1 - Math.cos(Math.PI * clamped)) / 2;
}

/**
 * Draws one frame of a turn. Where the turning page has lifted the canvas stays clear, so the
 * new page rendered beneath shows through; the old facing side stays covered until the sheet
 * lands on it. The context's transform must map CSS pixels (e.g. scaled by devicePixelRatio).
 */
export function drawCurl(ctx: CanvasRenderingContext2D, scene: CurlScene, progress: number): void {
  const mirror = scene.direction === 'prev';
  const frame = (rect: Rect): Rect => (mirror ? { ...rect, x: scene.width - rect.x - rect.width } : rect);
  const page = frame(scene.turning.rect);
  ctx.save();
  ctx.clearRect(0, 0, scene.width, scene.height);
  if (mirror) ctx.transform(-1, 0, 0, 1, scene.width, 0);

  // The facing side: its slot mirrors the turning page across the spine.
  ctx.fillStyle = scene.background;
  ctx.fillRect(page.x - page.width, page.y, page.width, page.height);
  if (scene.still) drawUpright(ctx, scene.still.image, frame(scene.still.rect), mirror);

  const fold = curlFold(page, progress);
  if (!fold) {
    drawUpright(ctx, scene.turning.image, page, mirror);
    ctx.restore();
    return;
  }

  // The part of the turning page still lying flat.
  if (fold.rest.length >= 3) {
    ctx.save();
    trace(ctx, fold.rest);
    ctx.clip();
    drawUpright(ctx, scene.turning.image, page, mirror);
    ctx.restore();
  }

  // The new page shows where the sheet lifted, darkest in the crease's shadow.
  if (fold.flap.length >= 3) {
    ctx.save();
    trace(ctx, fold.flap);
    ctx.clip();
    const reach = Math.max(1, Math.min(page.width * 0.3, fold.depth));
    const shade = ctx.createLinearGradient(
      fold.midpoint.x,
      fold.midpoint.y,
      fold.midpoint.x + fold.normal.x * reach,
      fold.midpoint.y + fold.normal.y * reach,
    );
    shade.addColorStop(0, 'rgba(0, 0, 0, 0.32)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shade;
    ctx.fillRect(page.x, page.y, page.width, page.height);
    ctx.restore();

    // The flap, folded over: the back of the sheet, casting a shadow on what it covers.
    ctx.save();
    ctx.transform(...foldReflection(fold));
    trace(ctx, fold.flap);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = scene.paper;
    ctx.fill();
    ctx.restore();
    ctx.clip();
    if (scene.back) {
      // Read from the spine outward, the back is the turning page mirrored; in the mirrored
      // frame of a backward turn that mirror cancels out.
      ctx.save();
      if (!mirror) ctx.transform(-1, 0, 0, 1, 2 * page.x + page.width, 0);
      ctx.drawImage(scene.back, page.x, page.y, page.width, page.height);
      ctx.restore();
    }
    const depth = Math.max(1, fold.depth);
    const curve = ctx.createLinearGradient(
      fold.midpoint.x,
      fold.midpoint.y,
      fold.midpoint.x + fold.normal.x * depth,
      fold.midpoint.y + fold.normal.y * depth,
    );
    curve.addColorStop(0, 'rgba(0, 0, 0, 0.2)');
    curve.addColorStop(0.15, 'rgba(255, 255, 255, 0.2)');
    curve.addColorStop(0.6, 'rgba(255, 255, 255, 0.04)');
    curve.addColorStop(1, 'rgba(0, 0, 0, 0.1)');
    ctx.fillStyle = curve;
    ctx.fillRect(page.x, page.y, page.width, page.height);
    ctx.restore();
  }
  ctx.restore();
}

function trace(ctx: CanvasRenderingContext2D, polygon: readonly Point[]) {
  ctx.beginPath();
  polygon.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
  ctx.closePath();
}

/** Draws an image into `rect` so that it reads the right way round in a mirrored frame. */
function drawUpright(ctx: CanvasRenderingContext2D, image: CanvasImageSource, rect: Rect, mirror: boolean) {
  ctx.save();
  if (mirror) ctx.transform(-1, 0, 0, 1, 2 * rect.x + rect.width, 0);
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}
