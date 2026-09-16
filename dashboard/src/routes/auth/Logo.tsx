type LogoProps = { size?: number };

export function Logo({ size = 26 }: LogoProps) {
  return (
    <span className="af-logo">
      {/* Placeholder brand mark: the Replayfy "R" (matches the landing/docs
          favicon) until a proper logo is designed. The .af-logo-mk square
          supplies the accent fill + white color + centering. */}
      <span
        className="af-logo-mk"
        style={{
          width: size,
          height: size,
          fontFamily: "Inter, system-ui, sans-serif",
          fontWeight: "var(--fw-bold)",
          fontSize: Math.round(size * 0.56),
          lineHeight: "var(--lh-none)",
        }}
      >
        R
      </span>
      Replayfy
    </span>
  );
}
