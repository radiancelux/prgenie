import os from "node:os";

const DEFAULT_HOST = "127.0.0.1";

export function defaultRunnerHost(): string {
  return DEFAULT_HOST;
}

/** First non-internal IPv4 (best effort for LAN URL in startup logs). */
export function bestEffortLanIpv4(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

export function runnerListenUrls(host: string, port: number): string[] {
  const bindHost = host.trim() || DEFAULT_HOST;
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    const urls = [`http://127.0.0.1:${port}/`];
    const lan = bestEffortLanIpv4();
    if (lan) urls.push(`http://${lan}:${port}/`);
    return urls;
  }
  if (bindHost === "127.0.0.1" || bindHost === "localhost") {
    return [`http://127.0.0.1:${port}/`];
  }
  return [`http://${bindHost}:${port}/`];
}

export function urlHostForRequest(configHost: string): string {
  const h = configHost.trim() || DEFAULT_HOST;
  return h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h;
}
