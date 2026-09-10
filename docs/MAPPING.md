# Mapping notes: the properties that look easy and are not

Per-property notes for the planner. Anything marked **calibrate** is a transfer function
to fit from data (M3), not a constant to guess. Anything marked **trap** is a place where
the obvious implementation is wrong in a way that ships.

---

## Drop shadows

CSS `box-shadow: <x> <y> <blur> <spread> <color>` maps onto Figma
`DropShadowEffect { color, offset, radius, spread, showShadowBehindNode, blendMode }`.
The field names line up. The semantics do not.

**Blur is not radius. (calibrate)** The CSS spec defines the shadow blur as approximating
a Gaussian with **standard deviation equal to half the blur radius**. Figma's effect
`radius` is a blur parameter whose kernel relationship is undocumented. So `blur: 12px`
is not `radius: 12`, and the error grows with blur — small shadows look fine, big soft
ones drift. This is the headline calibration target: sweep CSS blur against Figma radius
on a fixed box and fit the curve.

**Spread changes corner radii. (calibrate)** CSS spread expands the shadow's shape, and
on a rounded rect the spec adjusts the corner radius as it grows rather than offsetting
it rigidly. Figma has a spread field; whether it adjusts radii the same way is unverified.
Fit it on rounded boxes specifically, not squares — a square will agree and hide the bug.

**`showShadowBehindNode` must be `false`. (trap)** CSS clips an outer box-shadow so it is
**not painted inside the border-box**. Figma's default paints the shadow behind the whole
node, which is visible through any translucent fill. Leave the default and every
translucent card, glass panel and frosted overlay comes out muddy — subtly, plausibly,
and everywhere. This one boolean is probably the single most common invisible defect in
CSS→Figma tools.

**Multiple shadows: check paint order. (trap)** CSS paints the *first* shadow in the list
on top. Figma's `effects` array order must be verified against that, not assumed. Two
shadows of similar colour will look almost right either way, which is what makes it
dangerous.

**`filter: drop-shadow()` is a different feature.** It follows the element's **alpha
silhouette**, not its border box — so on a PNG with transparency, on text, or on a
`clip-path` shape it traces the actual outline. `box-shadow` always traces the box. If a
node has `filter: drop-shadow()` and is not a plain rectangle, do not map it to a Figma
drop shadow without verifying; the fallback is the raster rung.

**Inner shadows** with spread on rounded rects are where Figma diverges most. Calibrate
separately from outer; do not assume one curve fits both.

**Ladder.** Figma effect list → effect list with the hard layer rastered beneath the
editable parts → oracle tile. Shadows are worth keeping high: designers retune them
constantly, and a rastered shadow is a dead layer.

---

## Gradients

CSS gradients are described by angle and box geometry. Figma gradients are described by a
**`gradientTransform`** — a 2×3 affine matrix mapping gradient space into the node's
bounding box — plus normalised stops. Converting between them is the real work.

**The gradient line length formula. (trap)** CSS defines a linear gradient's line so that
the box's corners land exactly at 0% and 100%:

```
length = |W · sin(a)| + |H · cos(a)|
```

Implementations that skip this and just rotate a unit vector are correct on squares and
wrong on everything else. A wide hero is where it shows: the stops compress toward the
middle and the whole thing reads slightly off without looking obviously broken. Test
gradients on non-square boxes or the bug hides.

**Transparent stops must keep their hue. (trap)** `linear-gradient(red, transparent)`
interpolates toward *transparent red*. A naive conversion emits `rgba(0,0,0,0)` for
"transparent" and the gradient runs through transparent **black**, producing a dirty grey
band through the middle. Always carry the neighbouring stop's RGB into the alpha-0 stop.

**Colour interpolation space. (calibrate)** CSS interpolates in sRGB by default, but CSS
Color 4 syntax (`in oklch`, `in lab`) is increasingly used and interpolates very
differently — an oklch ramp through a hue is visibly not the sRGB one. Figma interpolates
in its own space. Detect the declared space; where it is not sRGB, sample the gradient
numerically and emit explicit stops rather than trusting either engine.

**Colour hints have no Figma equivalent.** The midpoint syntax (`red, 30%, blue`) shifts
where the 50% mix lands, non-linearly. Figma has no such concept. Approximate by sampling
the CSS gradient at N points and emitting N stops — this is also the general fallback for
anything the matrix cannot express.

**`repeating-*` has no Figma equivalent.** Expand into explicit repeated stops when the
repeat count over the box is small and bounded; otherwise raster.

**Radial sizing. (calibrate)** CSS radial gradients have a shape (circle/ellipse), a
position, and a size keyword — and the default is `farthest-corner`, not `farthest-side`.
Each keyword implies different radii, which then have to become a Figma ellipse matrix.
Get the default wrong and every unqualified `radial-gradient()` is subtly the wrong size.

**Conic → `GRADIENT_ANGULAR`.** Exists, but the starting angle and sweep direction
conventions differ from CSS. Verify both, on an asymmetric test pattern where a flip is
visible.

**Multiple background layers reverse. (trap)** CSS paints background layers
**first-listed on top**; Figma paints fills **last on top**. The list must be reversed.
Two gradients stacked the wrong way round is a striking failure that is easy to miss on
a page where the layers are similar.

**Ladder.** Figma `GradientPaint` → sampled N-stop approximation → image fill of the
oracle tile. Like shadows, gradients are worth keeping high on the ladder: they are among
the most-edited properties in any real design file.

---

## Why these two justify the architecture

Every item above is a place where a hand-written mapper produces something that looks
right in review and is wrong in a way nobody catches until a designer nudges a value and
watches it jump. There are dozens more like them across the CSS surface.

The pipeline answers each in a different place, and that division is the point:

- the **oracle** catches all of them per element, because the comparison is against
  Chrome's own pixels rather than anyone's reading of a spec;
- **calibration** fits the ones that are smooth functions (blur, spread, radial sizing)
  instead of guessing constants;
- the **emulator round-trip** catches the geometry maths (the gradient-line formula,
  the transform matrix) at corpus scale in CI;
- and the **raster rung** means the handful that remain unexpressible still *look* right,
  logged with a reason, rather than shipping as a plausible-looking mistake.
