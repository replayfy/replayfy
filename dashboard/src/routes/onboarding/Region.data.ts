export type RegionOption = {
  id: string;
  flag: string;
  name: string;
  ep: string;
};

export const REGIONS: RegionOption[] = [
  { id: "us", flag: "🇺🇸", name: "United States", ep: "us-east-1 · Virginia" },
  {
    id: "eu",
    flag: "🇪🇺",
    name: "European Union",
    ep: "eu-central-1 · Frankfurt",
  },
];
