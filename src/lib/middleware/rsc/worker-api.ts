import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";

import type {
  RenderInput,
  RenderOptions,
  GetBuildConfig,
  GetSsrConfig,
} from "../../../server.js";

const worker = new Worker(new URL("worker-impl.js", import.meta.url), {
  execArgv: [
    "--experimental-loader",
    "waku/node-loader",
    "--experimental-loader",
    "react-server-dom-webpack/node-loader",
    "--conditions",
    "react-server",
  ],
});

export type BuildOutput = {
  rscFiles: string[];
  htmlFiles: string[];
};

export type MessageReq =
  | { type: "shutdown" }
  | {
      id: number;
      type: "render";
      input: RenderInput;
      command: "dev" | "build" | "start";
      ctx: unknown;
      moduleIdCallback: boolean;
    }
  | { id: number; type: "getBuildConfig" }
  | {
      id: number;
      type: "getSsrConfig";
      pathStr: string;
      command: "dev" | "build" | "start";
    };

export type MessageRes =
  | { type: "full-reload" }
  | { id: number; type: "start"; ctx: unknown }
  | { id: number; type: "buf"; buf: ArrayBuffer; offset: number; len: number }
  | { id: number; type: "moduleId"; moduleId: string }
  | { id: number; type: "end" }
  | { id: number; type: "err"; err: unknown; statusCode?: number }
  | {
      id: number;
      type: "buildConfig";
      output: Awaited<ReturnType<GetBuildConfig>>;
    }
  | {
      id: number;
      type: "ssrConfig";
      output: Awaited<ReturnType<GetSsrConfig>>;
    };

const messageCallbacks = new Map<number, (mesg: MessageRes) => void>();

worker.on("message", (mesg: MessageRes) => {
  if ("id" in mesg) {
    messageCallbacks.get(mesg.id)?.(mesg);
  }
});

export function registerReloadCallback(fn: (type: "full-reload") => void) {
  const listener = (mesg: MessageRes) => {
    if (mesg.type === "full-reload") {
      fn(mesg.type);
    }
  };
  worker.on("message", listener);
  return () => worker.off("message", listener);
}

export function shutdown(): Promise<void> {
  return new Promise((resolve) => {
    worker.on("close", resolve);
    const mesg: MessageReq = { type: "shutdown" };
    worker.postMessage(mesg);
  });
}

let nextId = 1;

export function renderRSC<Context>(
  input: RenderInput,
  options: RenderOptions<Context>
): Promise<readonly [Readable, Context]> {
  const id = nextId++;
  let started = false;
  return new Promise((resolve, reject) => {
    const passthrough = new PassThrough();
    messageCallbacks.set(id, (mesg) => {
      if (mesg.type === "start") {
        if (!started) {
          started = true;
          resolve([passthrough, mesg.ctx as Context]);
        } else {
          throw new Error("already started");
        }
      } else if (mesg.type === "buf") {
        if (!started) {
          throw new Error("not yet started");
        }
        passthrough.write(Buffer.from(mesg.buf, mesg.offset, mesg.len));
      } else if (mesg.type === "moduleId") {
        options.moduleIdCallback?.(mesg.moduleId);
      } else if (mesg.type === "end") {
        if (!started) {
          throw new Error("not yet started");
        }
        passthrough.end();
        messageCallbacks.delete(id);
      } else if (mesg.type === "err") {
        const err =
          mesg.err instanceof Error ? mesg.err : new Error(String(mesg.err));
        if (mesg.statusCode) {
          (err as any).statusCode = mesg.statusCode;
        }
        if (!started) {
          reject(err);
        } else {
          passthrough.destroy(err);
        }
        messageCallbacks.delete(id);
      }
    });
    const mesg: MessageReq = {
      id,
      type: "render",
      input,
      command: options.command,
      ctx: options.ctx ?? null,
      moduleIdCallback: !!options.moduleIdCallback,
    };
    worker.postMessage(mesg);
  });
}

export function getBuildConfigRSC(): ReturnType<GetBuildConfig> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    messageCallbacks.set(id, (mesg) => {
      if (mesg.type === "buildConfig") {
        resolve(mesg.output);
        messageCallbacks.delete(id);
      } else if (mesg.type === "err") {
        reject(mesg.err);
        messageCallbacks.delete(id);
      }
    });
    const mesg: MessageReq = { id, type: "getBuildConfig" };
    worker.postMessage(mesg);
  });
}

export function getSsrConfigRSC(
  pathStr: string,
  command: "dev" | "build" | "start"
): ReturnType<GetSsrConfig> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    messageCallbacks.set(id, (mesg) => {
      if (mesg.type === "ssrConfig") {
        resolve(mesg.output);
        messageCallbacks.delete(id);
      } else if (mesg.type === "err") {
        reject(mesg.err);
        messageCallbacks.delete(id);
      }
    });
    const mesg: MessageReq = { id, type: "getSsrConfig", pathStr, command };
    worker.postMessage(mesg);
  });
}
