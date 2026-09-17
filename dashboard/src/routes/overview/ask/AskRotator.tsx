import { useEffect, useState } from "react";
import { ASK_ROTATE } from "../overview.data";

export function AskRotator() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % ASK_ROTATE.length), 2400);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="ask-ph">
      <span className="ask-roll">
        {ASK_ROTATE.map((q, k) => (
          <span
            key={k}
            className={
              "ask-roll-q" +
              (k === i
                ? " on"
                : k === (i - 1 + ASK_ROTATE.length) % ASK_ROTATE.length
                  ? " out"
                  : "")
            }
          >
            {q}
          </span>
        ))}
      </span>
    </span>
  );
}
