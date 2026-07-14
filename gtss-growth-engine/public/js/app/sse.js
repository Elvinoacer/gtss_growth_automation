function initSSE(url, onMessage) {
  let source;
  let closed = false;
  let retryTimer;

  function connect() {
    source = new EventSource(url);
    source.onmessage = (event) => {
      const data = event.data ? JSON.parse(event.data) : null;
      onMessage(data);
    };
    source.onerror = () => {
      source.close();
      if (!closed) {
        showToast("Connection lost. Attempting to reconnect...", "warning");
        retryTimer = window.setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return {
    close() {
      closed = true;
      window.clearTimeout(retryTimer);
      if (source) {
        source.close();
      }
    },
  };
}
