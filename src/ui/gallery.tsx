/**
 * The photo strip (`design/reference/api-contract.md`, Scope addition §A).
 *
 * A strip of the circle's or the gathering's photographs, captioned. A record
 * whose photo has no `objectKey` falls back to a generated plate in the same
 * frame, so a partly-photographed strip still reads as one set.
 *
 * No JS carousel, no dots, no arrows: it is a scroll container with CSS
 * snapping. `tabindex="0"` plus `role="group"` makes it a focusable region, so
 * the arrow keys scroll it — which is the whole keyboard story.
 */

import { Plate } from "./components";

export type GalleryItem = {
  /** `"The pump house, 06:30"`. Does the work a photograph would. */
  caption: string;
  /** Drives this item's own guilloché parameters — one per photo, not one per circle. */
  seed: string;
  /**
   * An R2 key. Set (the normal case) renders `<img src="/assets/…">`; null
   * falls back to a generated plate — see `PlateProps.objectKey`.
   */
  objectKey?: string | null;
};

export type GalleryProps = {
  /** Names the region for screen readers, e.g. "The Cold Room, photographs". */
  label: string;
  /** Picks the wash, so a circle's strip reads as one set. */
  category?: string;
  items: GalleryItem[];
};

export function Gallery(props: GalleryProps) {
  const { label, category = "", items } = props;
  if (items.length === 0) return null;

  return (
    <div class="gallery" tabindex={0} role="group" aria-label={label}>
      {items.map((item) => (
        <figure class="gallery-item">
          <Plate
            seed={item.seed}
            category={category}
            shape="bare"
            objectKey={item.objectKey}
            alt={item.caption}
          />
          <figcaption class="gallery-caption">{item.caption}</figcaption>
        </figure>
      ))}
    </div>
  );
}
