import { useEffect, useState } from "react";

type NfDigitProps = { d: number };

/* ---------- NumberFlow (digit-roll animated number) ---------- */
function NfDigit({ d }: NfDigitProps) {
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = requestAnimationFrame(() => setShown(d)); return () => cancelAnimationFrame(t); }, [d]);
  return <span className="nf-d"><span className="nf-col" style={{ transform: `translateY(-${shown * 10}%)` }}>{[0,1,2,3,4,5,6,7,8,9].map((n) => <span key={n}>{n}</span>)}</span></span>;
}

type NumberFlowProps = {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
};

export function NumberFlow({ value, decimals = 0, prefix = '', suffix = '', className = '' }: NumberFlowProps) {
  const neg = value < 0;
  const s = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (
    <span className={'nf ' + className}>
      {prefix}{neg ? '-' : ''}
      {[...s].map((ch, i) => /\d/.test(ch) ? <NfDigit key={i} d={+ch} /> : <span key={i} className="nf-sep">{ch}</span>)}
      {suffix}
    </span>
  );
}
