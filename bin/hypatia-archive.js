#!/usr/bin/env node

import { spawn } from "node:child_process";

const DEFAULT_PORT = 4174;

function usage() {
  return [
    "Usage: hypatia-archive [options]",
    "",
    "Options:",
    "  --port <number>  Listen on a local port (default: 4174)",
    "  --no-open        Do not open the browser after startup",
    "  -h, --help       Show this help message"
  ].join("\n");
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 through 65535.");
  }
  return port;
}

function parseOptions(argv) {
  let port = DEFAULT_PORT;
  let openBrowser = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") {
      const value = argv[index + 1];
      if (!value) throw new Error("--port requires a number.");
      port = parsePort(value);
      index += 1;
    } else if (argument === "--no-open") {
      openBrowser = false;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, port, openBrowser };
    } else {
      throw new Error("Unknown option: " + argument);
    }
  }

  return { help: false, port, openBrowser };
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    console.warn("Unable to open a browser automatically: " + error.message);
  });
  child.unref();
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid command options.");
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  process.env.NODE_ENV = "production";
  process.env.PORT = String(options.port);

  const { startServer } = await import("../lib/index.js");
  const server = startServer(options.port);

  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    console.error("Unable to start Hypatia Archive: " + (error instanceof Error ? error.message : "Unknown error."));
    process.exitCode = 1;
    return;
  }

  const url = "http://127.0.0.1:" + options.port;
  console.log("Hypatia Archive is available at " + url);
  if (options.openBrowser) openBrowser(url);
}

void main();
