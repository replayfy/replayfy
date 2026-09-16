import { BinaryReader } from "./binary-reader";

/**
 * Mobile SDK binary message protocol — decoder.
 *
 * Each message on the wire is:
 *   [varint type][varint timestamp][varint length][fields…]
 * The `length` is the byte size of the fields body (written by the
 * SDK's size-prefixed-blob wrapper); we read it but read the fields
 * directly after, exactly like the reference decoder.
 *
 * `batchMeta` (107) opens every batch and carries the monotonic
 * `firstIndex`. We decode each message to a flat, typed object the
 * persistence layer maps onto our event rows.
 */

export const MobileMsg = {
  Metadata: 92,
  Event: 93,
  UserID: 94,
  UserAnonymousID: 95,
  ScreenChanges: 96,
  Crash: 97,
  ViewComponentEvent: 98,
  ClickEvent: 100,
  InputEvent: 101,
  PerformanceEvent: 102,
  Log: 103,
  InternalError: 104,
  NetworkCall: 105,
  SwipeEvent: 106,
  BatchMeta: 107,
  GestureEvent: 108,
  GraphQL: 109,
} as const;

export type DecodedMobileMessage =
  | { tp: 92; kind: "metadata"; timestamp: number; key: string; value: string }
  | { tp: 93; kind: "event"; timestamp: number; name: string; payload: string }
  | { tp: 94; kind: "userId"; timestamp: number; id: string }
  | { tp: 95; kind: "userAnonymousId"; timestamp: number; id: string }
  | {
      tp: 96;
      kind: "screenChanges";
      timestamp: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      tp: 97;
      kind: "crash";
      timestamp: number;
      name: string;
      reason: string;
      stacktrace: string;
    }
  | {
      tp: 98;
      kind: "viewComponent";
      timestamp: number;
      screenName: string;
      viewName: string;
      visible: boolean;
    }
  | {
      tp: 100;
      kind: "click";
      timestamp: number;
      label: string;
      x: number;
      y: number;
    }
  | {
      tp: 101;
      kind: "input";
      timestamp: number;
      value: string;
      valueMasked: boolean;
      label: string;
    }
  | {
      tp: 102;
      kind: "performance";
      timestamp: number;
      name: string;
      value: number;
    }
  | {
      tp: 103;
      kind: "log";
      timestamp: number;
      severity: string;
      content: string;
    }
  | { tp: 104; kind: "internalError"; timestamp: number; content: string }
  | {
      tp: 105;
      kind: "networkCall";
      timestamp: number;
      type: string;
      method: string;
      url: string;
      request: string;
      response: string;
      status: number;
      duration: number;
    }
  | {
      tp: 106;
      kind: "swipe";
      timestamp: number;
      label: string;
      x: number;
      y: number;
      direction: string;
    }
  | { tp: 107; kind: "batchMeta"; timestamp: number; firstIndex: number }
  | {
      tp: 108;
      kind: "gesture";
      timestamp: number;
      // Advanced gesture variant: "long_press" | "double_tap" | "pinch".
      gestureKind: string;
      label: string;
      x: number;
      y: number;
      direction: string;
    }
  | {
      tp: 109;
      kind: "graphql";
      timestamp: number;
      operationKind: string;
      operationName: string;
      variables: string;
      response: string;
      duration: number;
    };

/**
 * Decode one full batch into an ordered list of messages.
 * Unknown message types abort the rest of the batch (the stream is
 * not self-delimiting once we can't size an unknown body) — we log
 * and return what we decoded so far. In practice the SDK only emits
 * the types above.
 */
export function decodeMobileBatch(buf: Buffer): {
  messages: DecodedMobileMessage[];
  firstIndex: number | null;
} {
  const reader = new BinaryReader(buf);
  const messages: DecodedMobileMessage[] = [];
  let firstIndex: number | null = null;

  while (!reader.done) {
    let type: number;
    try {
      type = reader.readUintNum();
    } catch {
      break; // trailing padding / clean EOF
    }
    const msg = decodeOne(type, reader);
    if (!msg) break; // unknown type — can't continue safely
    if (msg.tp === MobileMsg.BatchMeta && firstIndex === null) {
      firstIndex = msg.firstIndex;
    }
    messages.push(msg);
  }
  return { messages, firstIndex };
}

function decodeOne(type: number, r: BinaryReader): DecodedMobileMessage | null {
  // Every mobile message starts with timestamp + length.
  const timestamp = readTsLen(r);
  switch (type) {
    case MobileMsg.Metadata:
      return {
        tp: 92,
        kind: "metadata",
        timestamp,
        key: r.readString(),
        value: r.readString(),
      };
    case MobileMsg.Event:
      return {
        tp: 93,
        kind: "event",
        timestamp,
        name: r.readString(),
        payload: r.readString(),
      };
    case MobileMsg.UserID:
      return { tp: 94, kind: "userId", timestamp, id: r.readString() };
    case MobileMsg.UserAnonymousID:
      return { tp: 95, kind: "userAnonymousId", timestamp, id: r.readString() };
    case MobileMsg.ScreenChanges:
      return {
        tp: 96,
        kind: "screenChanges",
        timestamp,
        x: r.readUintNum(),
        y: r.readUintNum(),
        width: r.readUintNum(),
        height: r.readUintNum(),
      };
    case MobileMsg.Crash:
      return {
        tp: 97,
        kind: "crash",
        timestamp,
        name: r.readString(),
        reason: r.readString(),
        stacktrace: r.readString(),
      };
    case MobileMsg.ViewComponentEvent:
      return {
        tp: 98,
        kind: "viewComponent",
        timestamp,
        screenName: r.readString(),
        viewName: r.readString(),
        visible: r.readBoolean(),
      };
    case MobileMsg.ClickEvent:
      return {
        tp: 100,
        kind: "click",
        timestamp,
        label: r.readString(),
        x: r.readUintNum(),
        y: r.readUintNum(),
      };
    case MobileMsg.InputEvent:
      return {
        tp: 101,
        kind: "input",
        timestamp,
        value: r.readString(),
        valueMasked: r.readBoolean(),
        label: r.readString(),
      };
    case MobileMsg.PerformanceEvent:
      return {
        tp: 102,
        kind: "performance",
        timestamp,
        name: r.readString(),
        value: r.readUintNum(),
      };
    case MobileMsg.Log:
      return {
        tp: 103,
        kind: "log",
        timestamp,
        severity: r.readString(),
        content: r.readString(),
      };
    case MobileMsg.InternalError:
      return {
        tp: 104,
        kind: "internalError",
        timestamp,
        content: r.readString(),
      };
    case MobileMsg.NetworkCall:
      return {
        tp: 105,
        kind: "networkCall",
        timestamp,
        type: r.readString(),
        method: r.readString(),
        url: r.readString(),
        request: r.readString(),
        response: r.readString(),
        status: r.readUintNum(),
        duration: r.readUintNum(),
      };
    case MobileMsg.GestureEvent:
      return {
        tp: 108,
        kind: "gesture",
        timestamp,
        gestureKind: r.readString(),
        label: r.readString(),
        x: r.readUintNum(),
        y: r.readUintNum(),
        direction: r.readString(),
      };
    case MobileMsg.SwipeEvent:
      return {
        tp: 106,
        kind: "swipe",
        timestamp,
        label: r.readString(),
        x: r.readUintNum(),
        y: r.readUintNum(),
        direction: r.readString(),
      };
    case MobileMsg.BatchMeta:
      return {
        tp: 107,
        kind: "batchMeta",
        timestamp,
        firstIndex: r.readUintNum(),
      };
    case MobileMsg.GraphQL:
      return {
        tp: 109,
        kind: "graphql",
        timestamp,
        operationKind: r.readString(),
        operationName: r.readString(),
        variables: r.readString(),
        response: r.readString(),
        duration: r.readUintNum(),
      };
    default:
      return null;
  }
}

/**
 * Read the two header varints common to every mobile message:
 * `timestamp` then `length`. We return the timestamp and discard the
 * length (fields are read directly, same as the reference decoder).
 */
function readTsLen(r: BinaryReader): number {
  const timestamp = r.readUintNum();
  r.readUint(); // length — informational; fields read directly after
  return timestamp;
}
