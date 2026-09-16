import { useState } from "react";
import { Icon } from "@/components/primitives";
import { flagEmoji } from "@/lib/device-format";
import { dimIconHost, dimGlyph, faviconUrl } from "@/lib/url-format";

/* ============================================================================
   DimMark — the icon for one breakdown row's value. Always a real mark, never a
   bare colour swatch:
     · country       → flag emoji
     · brandable dim  → a favicon (browser / OS vendor, referrer host, utm
                        source) via the icon service, with an onError fall-back
                        to the dimension's glyph (so a 404 never shows a broken
                        image)
     · everything else → an Icon glyph (device type, channel, path, …)
   Shared by the Overview traffic panel, the Analytics Breakdowns table and the
   Trends legend so the same value is marked the same way everywhere.
   ========================================================================== */
export function DimMark({
  dimension,
  value,
  code,
  size = 16,
}: {
  dimension: string;
  value: string;
  /** Raw key for country (ISO-3166 alpha-2) — the flag needs the code, not the
   *  display name. Ignored for other dimensions. */
  code?: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);

  if (dimension === "country") {
    return (
      <span className="dim-mark flag" aria-hidden>
        {flagEmoji(code || value) || "🌐"}
      </span>
    );
  }

  const host = dimIconHost(dimension, value);
  if (host && !broken) {
    return (
      <img
        className="dim-mark ico"
        src={faviconUrl(host)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <span className="dim-mark glyph" aria-hidden>
      <Icon name={dimGlyph(dimension, value)} size={size - 2} />
    </span>
  );
}
