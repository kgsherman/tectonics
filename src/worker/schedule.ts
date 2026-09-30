/**
 * Macrotask scheduling via a private MessageChannel: setTimeout(0) is clamped to ≥ 4 ms when nested
 * (and throttled in background tabs); a channel message runs as soon as the queue allows.
 */
export function macrotaskScheduler(): (fn: () => void) => void {
  const channel = new MessageChannel();
  const queue: Array<() => void> = [];
  channel.port1.onmessage = () => {
    const fn = queue.shift();
    fn?.();
  };
  return (fn) => {
    queue.push(fn);
    channel.port2.postMessage(0);
  };
}
