/* replay frame (web / phone) — verbatim from prototype */
import { Icon } from "@/components/primitives";
import type { RvSession } from "../recordings.data";

export function RvFrame({ s, focus }: { s: RvSession; focus: boolean }) {
  const phone = s.plat === "ios" || s.plat === "android" || s.plat === "rn";
  const phoneShadow = focus
    ? "0 1px 2px rgba(0,0,0,.22), 0 14px 34px rgba(0,0,0,.28)"
    : "0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06)";
  const phoneBorder = focus
    ? "1px solid rgba(255,255,255,.09)"
    : "1px solid rgba(0,0,0,.06)";
  const webShadow = focus
    ? "0 0 0 1px rgba(18,20,26,.5), 0 1px 2px rgba(0,0,0,.28), 0 44px 84px -26px rgba(0,0,0,.6), 0 14px 36px -16px rgba(0,0,0,.42)"
    : "0 1px 2px rgba(17,17,20,.04), 0 28px 64px rgba(17,17,20,.17)";
  if (phone)
    return (
      <div
        style={{
          width: 292,
          height: 580,
          background: "#fff",
          borderRadius: 38,
          border: phoneBorder,
          boxShadow: phoneShadow,
          overflow: "hidden",
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-8)",
            padding: "var(--sp-16) var(--sp-16) var(--sp-12)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <Icon
            name="chev"
            size={14}
            style={{ transform: "rotate(90deg)", color: "var(--t2)" }}
          />
          <span style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)" }}>Checkout</span>
        </div>
        <div style={{ flex: 1, padding: "var(--sp-16)" }}>
          {["Aurora Headphones · $98", "USB-C Cable · $50"].map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                gap: "var(--sp-10)",
                alignItems: "center",
                marginBottom: "var(--sp-12)",
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "var(--r-md)",
                  background: "var(--line)",
                }}
              />
              <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-medium)" }}>{t}</div>
            </div>
          ))}
          <div
            style={{
              background: "#15161a",
              color: "#fff",
              textAlign: "center",
              padding: "var(--sp-10)",
              borderRadius: "var(--r-lg)",
              fontSize: "var(--text-base)",
              fontWeight: "var(--fw-semibold)",
              marginTop: "var(--sp-20)",
            }}
          >
            Pay with Apple Pay
          </div>
        </div>
      </div>
    );
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 1320,
        background: "#fff",
        borderRadius: "var(--r-lg)",
        boxShadow: webShadow,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-8)",
          padding: "var(--sp-8) var(--sp-12)",
          borderBottom: "1px solid var(--line-2)",
          background: "#fff",
        }}
      >
        <div style={{ display: "flex", gap: "var(--sp-6)" }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--line-strong)",
              }}
            />
          ))}
        </div>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            fontFamily: "var(--mono)",
            fontSize: "var(--text-xs)",
            color: "var(--t3)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            padding: "var(--sp-4) 0",
          }}
        >
          loop.shop{s.url}
        </div>
      </div>
      <div style={{ padding: "var(--sp-24) var(--sp-32) var(--sp-28)" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span
            style={{ fontWeight: "var(--fw-bold)", fontSize: "var(--text-lg)", letterSpacing: "-.3px" }}
          >
            loop.
          </span>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--t3)" }}>
            Cart · 2 items · $148.00
          </span>
        </div>
        <div
          style={{
            fontSize: "var(--text-xl)",
            fontWeight: "var(--fw-semibold)",
            letterSpacing: "-.4px",
            marginTop: "var(--sp-20)",
          }}
        >
          Checkout
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--t3)", marginTop: "var(--sp-4)" }}>
          Enter your payment details to complete the order.
        </div>
        {(
          [
            ["Email", 0],
            ["Card number", 1],
          ] as [string, number][]
        ).map(([l, e]) => (
          <div key={l} style={{ marginTop: "var(--sp-16)" }}>
            <div
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--fw-medium)",
                color: "var(--t2)",
                marginBottom: "var(--sp-6)",
              }}
            >
              {l}
            </div>
            <div
              style={{
                height: 38,
                borderRadius: "var(--r-md)",
                border: `1px solid ${e ? "var(--red)" : "var(--line-strong)"}`,
                background: e ? "var(--red-weak)" : "var(--surface)",
              }}
            />
          </div>
        ))}
        <div style={{ display: "flex", gap: "var(--sp-10)", marginTop: "var(--sp-16)" }}>
          {["Expiry", "CVC"].map((l) => (
            <div key={l} style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--fw-medium)",
                  color: "var(--t2)",
                  marginBottom: "var(--sp-6)",
                }}
              >
                {l}
              </div>
              <div
                style={{
                  height: 38,
                  borderRadius: "var(--r-md)",
                  border: "1px solid var(--line-strong)",
                }}
              />
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: "var(--sp-20)",
            background: "var(--accent)",
            color: "#fff",
            textAlign: "center",
            padding: "var(--sp-12)",
            borderRadius: "var(--r-md)",
            fontSize: "var(--text-md)",
            fontWeight: "var(--fw-semibold)",
          }}
        >
          Pay $148.00
        </div>
      </div>
    </div>
  );
}
