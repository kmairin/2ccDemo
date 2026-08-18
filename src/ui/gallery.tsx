/**
 * The photo strip (`design/reference/api-contract.md`, Scope addition §A).
 *
 * There is no photography and none can be obtained, so the gallery is a strip
 * of generated plates presented as an archive rather than as fake photographs.
 * The captions do the work the photographs would.
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
   * An R2 key. Null (the normal case today) renders a generated plate; set it
   * and `Plate` renders `<img src="/assets/…">` instead. That is the upgrade
   * path for real photographs — see `PlateProps.objectKey`.
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
