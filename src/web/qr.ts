/**
 * The phone joins by scanning a QR code of the approval page's URL. The URL
 * must be reachable from the phone, so it uses this machine's LAN address
 * (or DEMO_PUBLIC_URL when the network needs something else, e.g. a tunnel).
 */
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";

export const qrSvg = (text: string) => QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#16181D", light: "#FFFFFF" } });
export const qrTerminal = (text: string) => QRCode.toString(text, { type: "terminal", small: true });

/** First non-internal IPv4 address, preferring typical home/office ranges over VPN or container bridges. */
export function lanAddress(): string | undefined {
  const all = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
  return all.find((a) => /^(192\.168|10)\./.test(a)) ?? all.find((a) => !/^172\.(1[7-9]|2\d|3[01])\./.test(a)) ?? all[0];
}

/** Base URL the phone should use. */
export function publicBase(port: number): string {
  const override = process.env.DEMO_PUBLIC_URL;
  if (override) return override.replace(/\/$/, "");
  return `http://${lanAddress() ?? "localhost"}:${port}`;
}
