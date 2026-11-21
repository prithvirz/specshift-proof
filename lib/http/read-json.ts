/** Reads and parses a JSON request body, stopping as soon as it exceeds `maxBytes`. */

export type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" };

export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<ReadJsonResult> {
  // Cheap early rejection. The streaming check below still applies when the header is absent or wrong.
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return { ok: false, reason: "too_large" };

  if (!request.body) return { ok: false, reason: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
