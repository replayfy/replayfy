declare module "ua-parser-js" {
  interface UAResult {
    browser: { name?: string; version?: string };
    os: { name?: string; version?: string };
    device: { type?: string; vendor?: string; model?: string };
    engine: { name?: string; version?: string };
    cpu: { architecture?: string };
  }
  export class UAParser {
    constructor(ua?: string);
    getBrowser(): UAResult["browser"];
    getOS(): UAResult["os"];
    getDevice(): UAResult["device"];
    getResult(): UAResult;
  }
}
