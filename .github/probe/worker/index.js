// Временный воркер проверки: passthrough env.AI.run, как будет в проде.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.searchParams.get('k') !== env.PROBE_KEY) return new Response('no', { status: 403 });
    const { model, input } = await req.json();
    try {
      const out = await env.AI.run(model, input);
      if (out instanceof ReadableStream) {
        return new Response(out, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      return Response.json({ nonStream: out });
    } catch (e) {
      return Response.json(
        { thrown: String(e?.message ?? e), name: e?.name, ctor: e?.constructor?.name, keys: Object.keys(e ?? {}) },
        { status: 599 },
      );
    }
  },
};
