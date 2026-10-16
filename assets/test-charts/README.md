# ISO 12233 chart

Original SVG by Stephen H. Westin, Cornell University:
https://www.graphics.cornell.edu/~westin/misc/res-chart.html

Downloaded from https://www.graphics.cornell.edu/~westin/misc/ISO_12233-reschart.svg
on 2026-10-16. The original SVG and its credit are retained unchanged. The author
does not guarantee compliance with ISO 12233 or any other standard.

`src/scene/iso-chart-geometry.json` is generated from this SVG. It includes fills,
stroke outlines and outlines of the embedded fonts. Curves are tessellated with
eight segments per curve; straight resolution bars retain their exact boundaries.
SVG painter order is resolved by polygon clipping, so all triangles lie in one
plane, without overlapping depth layers. Both preview and physical lens rendering
use this same mesh and linear vertex colors, without a raster texture.

To regenerate: install the project's npm dependencies and Python `fonttools`, then
run `node scripts/build-iso-chart.mjs`. Normal builds use the checked-in geometry
and do not require Python.
