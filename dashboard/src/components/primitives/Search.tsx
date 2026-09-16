import { Icon } from "./Icon";

type SearchProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number | string;
  className?: string;
};

/* ---------- Search input ---------- */
export function Search({ value, onChange, placeholder = 'Search…', width = 230, className }: SearchProps) {
  return <div className={className ? `search ${className}` : 'search'} style={{ width }}><Icon name="search" size={13} /><input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></div>;
}
