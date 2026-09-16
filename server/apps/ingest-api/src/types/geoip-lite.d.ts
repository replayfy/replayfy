declare module "geoip-lite" {
  interface GeoLookup {
    range: [number, number];
    country: string;
    region: string;
    eu: "0" | "1";
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  }
  const geoip: {
    lookup(ip: string): GeoLookup | null;
  };
  export default geoip;
}
