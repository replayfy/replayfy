import { decodeMobileBatch } from "../src/mobile/mobile-messages";

// ---- SDK-exact encoder (mirrors the Swift/Kotlin Data writer) ----
function writeUint(v: number): number[] {
  const out: number[] = [];
  let n = BigInt(v);
  while (n >= 0x80n) { out.push(Number((n & 0x7fn)) | 0x80); n >>= 7n; }
  out.push(Number(n));
  return out;
}
function writeStr(s: string): number[] {
  const bytes = Buffer.from(s, "utf8");
  return [...writeUint(bytes.length), ...bytes];
}
function writeBool(b: boolean): number[] { return [b ? 1 : 0]; }
// message = type + timestamp + length-prefixed(body)
function msg(type: number, ts: number, body: number[]): number[] {
  return [...writeUint(type), ...writeUint(ts), ...writeUint(body.length), ...body];
}

const batch = Buffer.from([
  ...msg(107, 1000, writeUint(0)),                                   // batchMeta firstIndex=0
  ...msg(100, 1010, [...writeStr("UIButton 'Buy'"), ...writeUint(540), ...writeUint(344)]), // click
  ...msg(101, 1020, [...writeStr("secret"), ...writeBool(true), ...writeStr("Password")]),  // input masked
  ...msg(102, 1030, [...writeStr("memoryUsage"), ...writeUint(136000000)]),                 // perf
  ...msg(106, 1040, [...writeStr("UIScrollView"), ...writeUint(10), ...writeUint(20), ...writeStr("up")]), // swipe
  ...msg(105, 1050, [...writeStr("xhr"), ...writeStr("GET"), ...writeStr("https://api.x/y"), ...writeStr("{}"), ...writeStr("{ok:1}"), ...writeUint(200), ...writeUint(42)]), // network
  ...msg(97, 1060, [...writeStr("NSException"), ...writeStr("boom"), ...writeStr("frame1\nframe2")]), // crash
  ...msg(96, 1070, [...writeUint(0), ...writeUint(0), ...writeUint(1170), ...writeUint(2532)]), // screenChanges
]);

const { messages, firstIndex } = decodeMobileBatch(batch);
console.log("firstIndex:", firstIndex);
console.log("decoded", messages.length, "messages:");
for (const m of messages) console.log(" ", JSON.stringify(m));

// assertions
const click = messages.find((m) => m.kind === "click") as any;
const input = messages.find((m) => m.kind === "input") as any;
const net = messages.find((m) => m.kind === "networkCall") as any;
const screen = messages.find((m) => m.kind === "screenChanges") as any;
const ok =
  firstIndex === 0 && messages.length === 8 &&
  click.label === "UIButton 'Buy'" && click.x === 540 && click.y === 344 &&
  input.valueMasked === true && input.label === "Password" &&
  net.method === "GET" && net.status === 200 && net.duration === 42 &&
  screen.width === 1170 && screen.height === 2532;
console.log(ok ? "\nPASS — decoder matches the wire format" : "\nFAIL");
process.exit(ok ? 0 : 1);
