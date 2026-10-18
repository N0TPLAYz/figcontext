# Motion recipes — baking real motion out of the Motion (Beta) API

Motion has keyframes but **no physics engine**. Anything that should feel physical (inertia,
follow-through, a pinned point with a free end) has to be *simulated offline* and baked into a
`set_manual_keyframes` track. The track is still one tool call; only the numbers are precomputed.

Two rules that make baked motion look hand-made:

1. **Sample dense and interpolate `LINEAR`.** 30–60 Hz. Eased interpolation between sparse keys
   fights the simulation; `LINEAR` between dense keys reproduces the solved curve exactly.
2. **Bake position and rotation from the same simulation.** Never hand-author a rotation to "match"
   a path — solve them together or the two drift apart.

## Why the tip must be its own node

Figma rotates a node around its **bounding-box centre**. So "pin the tip, let the body swing" needs
the pin to BE the centre:

```
frame "Cursor anchor"  (64×64, invisible, no fill, centre == the hotspot)
├── vector "Cursor body"   offset so its TOP-LEFT CORNER sits on the anchor centre
└── ellipse "Hotspot"      4×4 at the centre — the visible proof the point never moves
```

- anchor `TRANSLATION_X` / `TRANSLATION_Y` → the pinned tip's path
- anchor `ROTATION` → the body's swing (pivots about the tip, because the tip is the centre)
- body `SCALE_X` / `SCALE_Y` → squash & stretch

A frame is used rather than a group because a **group rotates around its bbox centre**, which is
not the tip. Do not set `clipContent:false` — size the anchor so the body fits inside instead.

## Curved travel

Cubic Bézier for the path, `smoothstep` on the time parameter so it glides in and decelerates:

```js
const bez = (s) => { const u = 1 - s, a = u*u*u, b = 3*u*u*s, c = 3*u*s*s, d = s*s*s;
  return { x: a*P0.x + b*P1.x + c*P2.x + d*P3.x, y: a*P0.y + b*P1.y + c*P2.y + d*P3.y }; };
const smooth = (x) => x * x * (3 - 2 * x);            // C1-continuous, no velocity kink at the ends
tipAt = (t) => t <= T_ARRIVE ? bez(smooth((t - T_IN) / (T_ARRIVE - T_IN))) : /* press dip, settle, hold */;
```

Two control points on the far side of the chord is what makes the swoop read as a curve rather than
a diagonal slide. Then add a short **press dip** (a few px past the target, ~80 ms) and a settle —
the click needs an impulse for the physics to react to.

## Pinned-tip physics: the arrow as a rigid pendulum

Pinning a point removes 2 DOF, so the body has exactly **one**: rotation about the pin. Model the
arrow as a rigid rod whose centre of mass is `C` px from the pin, at rest angle `THETA_REST`:

```js
const C = Math.hypot(AW_W / 2, AW_H / 2);          // pin -> CoM, from the real bbox
const THETA_REST = Math.atan2(AW_H / 2, AW_W / 2);  // the arrow's own CoM direction (53.7deg for 22×30)

// y is DOWN in Figma; theta grows clockwise. Forcing from the pin's acceleration:
//   torque/I = -(u x a)/C   with u = (cos th, sin th), cross(u,a) = u.x*a.y - u.y*a.x
const wrist   = -OMEGA * OMEGA * (th - THETA_REST);   // the "hand" holding the pointer
const damping = -2 * ZETA * OMEGA * om;
const inertia = -(u.x * a.y - u.y * a.x) / C;         // <-- the whole effect
const alpha   = wrist + damping + inertia;             // gravity is ZERO: a hand holds a cursor
```

**Set gravity to 0.** With a gravity term `(G/C)·cos(th)` the body gets a permanent ~15° bias toward
straight-down and only ever swings one way — it stops looking like a hand-held pointer. Gravity is
the wrong model here; the wrist spring *is* the hand.

**Why this gives the requested behaviour:** accelerate the tip right and `-(u × a)/C` goes positive,
`th` grows, and the body's far corner sweeps toward straight-down — i.e. **to the left of where it
rests**. Accelerate left and it swings the other way. The direction is derived from the real
acceleration vector, so amplitude tracks speed automatically. **Do not normalise the acceleration**
(`a / aMax`) — that erases the speed→amplitude relationship and is what makes baked physics look
fake and amplitude-identical on every move.

Integrate at a small fixed step and sample up:

```js
const DT = 1 / 480, STEP = 1 / 60;         // substep for stability, sample at playback rate
for (let t = 0; t <= DUR; t += STEP) {
  const a = numericDerivative(tipAt, t);   // central difference, h = 1e-4
  const alpha = wrist + damping + inertia;
  keys.push({ t: r2(t), value: r2((th - THETA_REST) * 180 / Math.PI), easing: "LINEAR" });
  for (let k = 0; k < STEP / DT; k++) { om += alpha * DT; th += om * DT; }
}
```

Keyframe `value` for `ROTATION` is **degrees**; positive = clockwise.

## Tuning (measured, arc ≈ 406 px, travel 1.2 s, peak tip accel ≈ 536 px/s²)

| ω (wrist) | ζ | peak swing | reads as |
|---|---|---|---|
| 15 | 0.28 | ~7° | barely-there weight, ~4 px at the far corner |
| 10 | 0.30 | ~17° | visible lag, settles in ~0.6 s — the sweet spot for "professional" |
| 8.5 | 0.30 | ~23° | loose and bouncy |
| 5 | 0.25 | ~45°+ | whip, not a cursor |

Swing amplitude scales as `1/ω²` (quasi-static), so ω is the master "how much give" knob. Faster
travel (shorter `T_ARRIVE`) raises tip acceleration and therefore swing, for free.

## Squash & stretch

Derive it from angular acceleration, but keep it small (≤5%) or it reads as rubber:

```js
const stretch = Math.min(1, Math.abs(alpha) / 900);   // the /900 is a DISPLAY mapping, not physics
sx = 1 + 0.05 * stretch,  sy = 1 - 0.03 * stretch;     // volume-ish preserving, X along the arrow
```

## Button press → pop → vanish

Retime the button to the dip, and get the overshoot pop from a cubic Bézier rather than a named
easing (works on any build):

```js
const BACK = { bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } };   // == EASE_OUT_BACK
// SCALE_XY needs VECTOR values:
{ t: 1.44, value: V(1, 1) }, { t: 1.49, value: V(0.93, 0.93), easing: "EASE_IN" },
{ t: 1.63, value: V(1.06, 1.06), easing: BACK }, { t: 1.90, value: V(0, 0), easing: "EASE_IN_AND_OUT" }
// plus OPACITY 1 → 0 across the same 1.63 → 1.90 collapse
```

## Order of operations that actually works

1. Create the page/frame/button/art. Note every id.
2. Bake + apply **one track per call** (`x`, then `y`, then `opacity`, then `rotation`). Batching
   several tracks in one request is fine, but a single bad track aborts the rest — separate calls
   make the failing field obvious.
3. `get_node_animations { nodeId }` → read `timelines[0].id` → `set_timeline_duration`.
4. `get_node_animations` again and verify keyframe counts per field.
5. Preview: `export_node { nodeId, format:'MP4', fps:30 }`.

Never hardcode a timeline id — see the timeline-id landmine in `tools.md`.
