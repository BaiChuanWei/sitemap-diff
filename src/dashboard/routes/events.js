const MAX_CONNECTIONS = 20;
const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * SSE 事件广播器（M1 只有心跳骨架，真实采集事件在 M3 接入）。
 * 单进程内存态即可，本地单用户场景不需要跨进程广播。
 */
export class EventHub {
  constructor() {
    this.connections = new Set();
    this.heartbeatTimer = setInterval(() => this.broadcast('heartbeat', { at: new Date().toISOString() }), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  /** 处理一个新的 SSE 请求；返回 false 表示已达最大连接数，调用方应该拒绝。 */
  handleRequest(req, res) {
    if (this.connections.size >= MAX_CONNECTIONS) {
      return false;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    this.connections.add(res);
    req.on('close', () => this.connections.delete(res));
    return true;
  }

  broadcast(eventName, payload) {
    const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.connections) {
      try {
        res.write(line);
      } catch {
        this.connections.delete(res);
      }
    }
  }

  get connectionCount() {
    return this.connections.size;
  }

  close() {
    clearInterval(this.heartbeatTimer);
    for (const res of this.connections) {
      try {
        res.end();
      } catch {
        // 忽略已经关闭的连接
      }
    }
    this.connections.clear();
  }
}
