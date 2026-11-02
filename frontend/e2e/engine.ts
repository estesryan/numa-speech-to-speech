import { createConnection } from "node:net";

/** Whether the voice engine is listening on 127.0.0.1:8765. */
export function engineRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 8765 }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}
