/** `list` with item `i` replaced by `v` (i = -1 appends), or removed when `v` is null. */
export const withItem = <T,>(list: T[], i: number, v: T | null): T[] =>
  i < 0 ? [...list, v as T] : list.flatMap((x, n) => (n !== i ? [x] : v === null ? [] : [v]));

/** `list` with items `i` and `i + d` swapped. */
export function swapped<T>(list: T[], i: number, d: -1 | 1): T[] {
  const l = [...list];
  [l[i], l[i + d]] = [l[i + d], l[i]];
  return l;
}

export const when = (unix: number) => new Date(unix * 1000).toLocaleString();
