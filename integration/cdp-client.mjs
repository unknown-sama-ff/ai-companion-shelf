export async function readCdpJson(port, resource) {
  const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Local browser request failed with HTTP ${response.status}.`);
  return response.json();
}

export async function connectCdp(webSocketUrl, port) {
  const url = new URL(webSocketUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      Number(url.port) !== Number(port) || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith('/devtools/')) {
    throw new Error('The browser debugger must use the verified local endpoint.');
  }
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Browser connection timed out.'));
    }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', (error) => { clearTimeout(timeout); reject(error); }, { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('The local browser session closed.'));
    }
    pending.clear();
  });
  return {
    request(method, params = {}, timeoutMilliseconds = 15000) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The browser connection is closed.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser request timed out: ${method}`));
        }, timeoutMilliseconds);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

export async function evaluate(session, expression) {
  const result = await session.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, 60000);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}
