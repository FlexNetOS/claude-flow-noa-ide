import { createVisualizerServer } from "./create-server.js";

const visualizer = createVisualizerServer();

await visualizer.listen();
const seeded = visualizer.seedSession("demo-ruflo-swarm");

console.log(
  JSON.stringify(
    {
      message: "Visualizer server started",
      http: "http://localhost:8787/api/health",
      websocket: "ws://localhost:8787/ws/visualizer",
      seededSession: seeded.sessionId
    },
    null,
    2
  )
);
