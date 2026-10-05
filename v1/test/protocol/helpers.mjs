// Shared protocol-test plumbing: a recording in-memory NetworkPort.
// No real sockets: every provider request is captured and answered locally.
export function makeNetwork(responder) {
  const calls = [];
  const network = {
    calls,
    async request(init) {
      calls.push(init);
      if (init.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'CANCELLED' });
      }
      const result = await responder(init, calls.length - 1);
      if (result instanceof Error) throw result;
      const body = result.body ?? result.text ?? new Uint8Array();
      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
      };
    },
  };
  return network;
}

export function jsonResponse(value, status = 200) {
  return { status, text: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}

export function jsonBody(init) {
  return JSON.parse(new TextDecoder().decode(init.body));
}

export function formBody(init) {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(init.body)));
}

export function textBody(init) {
  return new TextDecoder().decode(init.body);
}

export const signal = () => new AbortController().signal;