// Minimal typing for the parts of "qrcode" (1.5.x, CommonJS, ships no types) used by src/web/qr.ts.
declare module "qrcode" {
  interface Options { type?: "svg" | "terminal" | "utf8"; margin?: number; small?: boolean; errorCorrectionLevel?: "L" | "M" | "Q" | "H"; color?: { dark?: string; light?: string } }
  const QRCode: { toString(text: string, options?: Options): Promise<string> };
  export default QRCode;
}
