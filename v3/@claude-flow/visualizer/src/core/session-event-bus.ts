import { EventEmitter } from "node:events";
import type { VisualizerEvent } from "../contracts/events.js";

export class SessionEventBus {
  private readonly emitter = new EventEmitter();

  publish(event: VisualizerEvent): void {
    this.emitter.emit(event.sessionId, event);
    this.emitter.emit("*", event);
  }

  subscribe(sessionId: string, listener: (event: VisualizerEvent) => void): () => void {
    this.emitter.on(sessionId, listener);
    return () => this.emitter.off(sessionId, listener);
  }

  subscribeAll(listener: (event: VisualizerEvent) => void): () => void {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }
}
