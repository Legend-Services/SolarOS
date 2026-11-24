/**
 * macOS-style Dock magnification. Each icon's *layout* size (not a CSS transform) follows a cosine bell around the
 * cursor, so neighbours are pushed outward and icons never overlap. Distances are measured on the unmagnified layout
 * (centred on the dock's midpoint) so the curve doesn't feed back on itself as the dock widens.
 *
 * @param n       number of slots
 * @param base    unmagnified icon size (px)
 * @param gap     gap between slots (px)
 * @param peak    scale at the cursor (1 = off)
 * @param mouseX  cursor x relative to the dock's horizontal centre, or null when the cursor is away
 */
export function dockSizes(n: number, base: number, gap: number, peak: number, mouseX: number | null): number[] {
  const total = n * base + (n - 1) * gap;
  const range = base * 3; // cursor influence radius: about 2½ neighbours on each side
  return Array.from({ length: n }, (_, i) => {
    if (mouseX === null || peak <= 1) return base;
    const d = Math.abs(mouseX - (-total / 2 + i * (base + gap) + base / 2));
    return d >= range ? base : base + base * (peak - 1) * ((Math.cos((Math.PI * d) / range) + 1) / 2);
  });
}
