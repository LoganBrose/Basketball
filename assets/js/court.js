/**
 * Court geometry.
 *
 * Everything is in feet, drawn straight into an SVG viewBox, so a token at
 * x:25 really is at half-court width and a 19'9" arc really is 19'9". The
 * baseline is y=0 at the top of the diagram, which is how plays are drawn on a
 * whiteboard.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

export const COURT_WIDTH = 50;
export const HALF_LENGTH = 47;
export const FULL_LENGTH = 94;

/** Rim centre: 4ft backboard + 15in from board face to ring centre. */
export const BASKET = { x: 25, y: 5.25 };

export const COURT_PRESETS = {
  hs: {
    label: 'High School',
    three: 19.75, // 19'9"
    lane: 12,
    cornerX: null, // pure arc — it meets the baseline before reaching the sideline
  },
  ncaa: {
    label: 'College',
    three: 22.146, // 22'1.75"
    lane: 12,
    cornerX: null,
  },
  nba: {
    label: 'NBA',
    three: 23.75, // 23'9", with 22ft corners
    lane: 16,
    cornerX: 3, // straight corner segments 3ft off each sideline
  },
};

export function courtSize(type) {
  return { w: COURT_WIDTH, h: type === 'full' ? FULL_LENGTH : HALF_LENGTH };
}

function node(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * Where the three-point line leaves the baseline.
 * Either a fixed corner inset (NBA) or wherever the arc crosses y=0.
 */
function cornerGeometry(preset) {
  const R = preset.three;
  if (preset.cornerX != null) {
    const dx = BASKET.x - preset.cornerX;
    // How far up the straight corner segment runs before the arc takes over.
    const dy = Math.sqrt(Math.max(R * R - dx * dx, 0));
    return { x: preset.cornerX, y: BASKET.y + dy };
  }
  const dx = Math.sqrt(Math.max(R * R - BASKET.y * BASKET.y, 0));
  return { x: BASKET.x - dx, y: 0 };
}

/** One end of the floor: hoop, lane, three-point line. */
function buildEnd(preset) {
  const g = node('g', { class: 'court-lines' });
  const R = preset.three;
  const laneHalf = preset.lane / 2;
  const corner = cornerGeometry(preset);

  // Lane ("the paint"): baseline to the free-throw line at 19ft.
  g.append(node('rect', { x: BASKET.x - laneHalf, y: 0, width: preset.lane, height: 19, class: 'lane' }));

  // Free-throw circle: solid away from the basket, dashed over the lane.
  g.append(node('path', { d: `M ${BASKET.x - 6} 19 A 6 6 0 0 0 ${BASKET.x + 6} 19`, class: 'line' }));
  g.append(node('path', { d: `M ${BASKET.x - 6} 19 A 6 6 0 0 1 ${BASKET.x + 6} 19`, class: 'line dashed' }));

  // Three-point line: straight corner segments, then the arc.
  // large-arc=1 sweep=0 is the half that bulges away from the baseline.
  const d =
    `M ${corner.x} 0 L ${corner.x} ${corner.y} ` +
    `A ${R} ${R} 0 1 0 ${COURT_WIDTH - corner.x} ${corner.y} ` +
    `L ${COURT_WIDTH - corner.x} 0`;
  g.append(node('path', { d, class: 'line' }));

  // Backboard and rim.
  g.append(node('line', { x1: BASKET.x - 3, y1: 4, x2: BASKET.x + 3, y2: 4, class: 'line thick' }));
  g.append(node('line', { x1: BASKET.x, y1: 4, x2: BASKET.x, y2: BASKET.y - 0.75, class: 'line' }));
  g.append(node('circle', { cx: BASKET.x, cy: BASKET.y, r: 0.75, class: 'rim' }));

  return g;
}

/**
 * Draw the floor into `parent`.
 * A full court is the same end drawn twice, the second rotated 180° about the
 * centre of the floor — so the geometry is defined once and can't drift.
 */
export function renderCourt(parent, { type = 'half', preset = 'hs' } = {}) {
  const p = COURT_PRESETS[preset] || COURT_PRESETS.hs;
  const { w, h } = courtSize(type);
  const g = node('g', { class: 'court' });

  g.append(node('rect', { x: 0, y: 0, width: w, height: h, class: 'floor' }));

  g.append(buildEnd(p));

  if (type === 'full') {
    const far = buildEnd(p);
    far.setAttribute('transform', `rotate(180 ${w / 2} ${h / 2})`);
    g.append(far);

    g.append(node('line', { x1: 0, y1: h / 2, x2: w, y2: h / 2, class: 'line' }));
    g.append(node('circle', { cx: w / 2, cy: h / 2, r: 6, class: 'line' }));
    g.append(node('circle', { cx: w / 2, cy: h / 2, r: 2, class: 'line' }));
  } else {
    // Half court: the division line is the far boundary, with the centre
    // circle showing as the half that's actually on this side of the floor.
    g.append(node('path', { d: `M ${w / 2 - 6} ${h} A 6 6 0 0 1 ${w / 2 + 6} ${h}`, class: 'line' }));
  }

  parent.append(g);
  return g;
}
